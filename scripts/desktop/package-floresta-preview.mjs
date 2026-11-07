// An unpacked developer preview for the build host. No installer or update
// artifact is created. The normal package and release workflows do not call it.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { extractFile } from '@electron/asar';
import { build, Platform } from 'electron-builder';
import { load as loadYaml } from 'js-yaml';
import settings from '../../desktop/floresta-settings.cjs';
import preview from '../../desktop/floresta-preview.cjs';
import verifyPackage from '../../build/verify-package.cjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const licenses = {
  'LICENSE.md': 'aeead5cd90e4f682f912c06949584fef9a77b9997c286e30153ce9f4278008ca',
  'LICENSE-APACHE': 'a6cba85bc92e0cff7a450b1d873c0eaa2e9fc96bf472df0247a26bec77bf3ff9',
  'LICENSE-MIT': 'f0ba1af4e8236d88591450d05c54ac4c39436075f0bf8b8967cba53e5de727a2',
};
const hash = async file => createHash('sha256').update(await fs.readFile(file)).digest('hex');
const sign = args => execFileSync('/usr/bin/codesign', args, { stdio: 'inherit' });

async function packagePreview(digest) {
  if (!preview.supportedHost(process.platform, process.arch)) throw new Error('Build the preview on a supported target host.');
  const mac = process.platform === 'darwin';
  const source = settings.candidate(root, digest);
  const sourceDirectory = path.dirname(source.binary);
  const stage = await fs.mkdtemp(path.join(os.tmpdir(), 'chicory-floresta-package-'));
  let output, complete = false;
  try {
    const binaryName = path.basename(source.binary);
    const binary = path.join(stage, binaryName);
    await fs.copyFile(source.binary, binary);
    if (await hash(binary) !== digest) throw new Error('The candidate binary differs from the selected source build.');
    for (const [name, expected] of Object.entries(licenses)) {
      const file = path.join(stage, name);
      await fs.copyFile(path.join(sourceDirectory, name), file);
      if (await hash(file) !== expected) throw new Error('The candidate license differs from the pinned upstream release.');
    }
    // Sign the exact child before packing app.asar. Re-signing it afterward
    // would change the bytes the supervisor is required to authenticate.
    if (mac) {
      sign(['--force', '--sign', '-', '--options', 'runtime', '--timestamp=none', '--identifier', 'com.chicory.desktop.floresta-preview.florestad', binary]);
      sign(['--verify', '--strict', binary]);
    }
    const pin = { version: 1, platform: process.platform, arch: process.arch, ...source.receipt,
      sourceBinarySha256: digest, sha256: await hash(binary) };
    const productName = 'Chicory Floresta Preview';
    const parent = path.join(root, 'release', 'floresta-preview');
    await fs.mkdir(parent, { recursive: true });
    output = await fs.mkdtemp(path.join(parent, 'build-'));
    let appPath, resources;
    // Read the development config before overriding it. electron-builder's
    // extends merges arrays, which would retain the ordinary payment handlers.
    const base = loadYaml(await fs.readFile(path.join(root, 'build', 'electron-builder.yml'), 'utf8'));
    await build({ projectDir: root, targets: Platform.current().createTarget('dir'), publish: 'never', config: {
      ...base, appId: 'com.chicory.desktop.floresta-preview', productName,
      directories: { ...base.directories, output }, protocols: [], publish: null,
      extraResources: [...base.extraResources, { from: stage, to: 'runtime/floresta', filter: [binaryName, ...Object.keys(licenses)] }],
      extraMetadata: { chicoryChannel: 'floresta-preview', chicoryFlorestaPreview: pin },
      mac: { ...base.mac, identity: '-', notarize: false, signIgnore: ['/Contents/Resources/runtime/floresta/florestad$'] },
      win: { ...base.win, signExecutable: false },
      linux: { ...base.linux, executableName: 'chicory-floresta-preview' },
      afterPack: async context => {
        await verifyPackage(context);
        assert.equal(context.packager.config.protocols.length, 0);
        assert.ok(!context.packager.platformSpecificBuildOptions.protocols?.length);
        appPath = mac ? path.join(context.appOutDir, productName + '.app') : context.appOutDir;
        resources = context.packager.getResourcesDir(context.appOutDir);
      },
    } });
    if (mac) {
      const info = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path.join(appPath, 'Contents', 'Info.plist')]));
      if (info.CFBundleIdentifier !== 'com.chicory.desktop.floresta-preview' || info.CFBundleURLTypes?.length) {
        throw new Error('The preview must have its own app identifier and leave payment links to the wallet.');
      }
    }
    assert.ok(!(await fs.readdir(resources)).includes('app-update.yml'), 'The developer preview must omit the update feed.');
    const metadata = JSON.parse(extractFile(path.join(resources, 'app.asar'), 'package.json'));
    assert.deepEqual(metadata.chicoryFlorestaPreview, pin, 'app.asar must retain the selected source receipt and final checksum.');
    const packaged = preview.previewCandidate(metadata, resources);
    if (packaged?.sha256 !== pin.sha256 || await hash(packaged.binary) !== pin.sha256) {
      throw new Error('The final packaged daemon differs from the checksum embedded in app.asar.');
    }
    const entries = await fs.readdir(path.dirname(packaged.binary), { withFileTypes: true });
    assert.ok(entries.every(entry => entry.isFile()));
    assert.deepEqual(entries.map(entry => entry.name).sort(), [binaryName, ...Object.keys(licenses)].sort());
    for (const [name, expected] of Object.entries(licenses)) {
      if (await hash(path.join(path.dirname(packaged.binary), name)) !== expected) throw new Error('A packaged Floresta license is incorrect.');
    }
    if (mac) {
      sign(['--verify', '--strict', packaged.binary]);
      sign(['--verify', '--deep', '--strict', appPath]);
    }
    complete = true;
    console.log(appPath);
  } finally {
    await fs.rm(stage, { recursive: true, force: true });
    if (output && !complete) await fs.rm(output, { recursive: true, force: true });
  }
}

const { values } = parseArgs({ options: { sha256: { type: 'string' } } });
await packagePreview(values.sha256);
