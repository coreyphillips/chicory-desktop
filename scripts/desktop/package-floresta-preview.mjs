// An unpacked developer preview for the host Mac. No installer or update
// artifact is created. The normal package and release workflows do not call it.
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

const root = fileURLToPath(new URL('../../', import.meta.url));
const licenses = {
  'LICENSE.md': 'aeead5cd90e4f682f912c06949584fef9a77b9997c286e30153ce9f4278008ca',
  'LICENSE-APACHE': 'a6cba85bc92e0cff7a450b1d873c0eaa2e9fc96bf472df0247a26bec77bf3ff9',
  'LICENSE-MIT': 'f0ba1af4e8236d88591450d05c54ac4c39436075f0bf8b8967cba53e5de727a2',
};
const hash = async file => createHash('sha256').update(await fs.readFile(file)).digest('hex');
const sign = args => execFileSync('/usr/bin/codesign', args, { stdio: 'inherit' });

async function packagePreview(digest) {
  if (process.platform !== 'darwin') throw new Error('This unpacked preview currently supports the host Mac.');
  const source = settings.candidate(root, digest);
  const sourceDirectory = path.dirname(source.binary);
  const receipt = JSON.parse(await fs.readFile(path.join(sourceDirectory, 'bundle.json'), 'utf8'));
  const stage = await fs.mkdtemp(path.join(os.tmpdir(), 'chicory-floresta-package-'));
  let output, complete = false;
  try {
    const binary = path.join(stage, 'florestad');
    await fs.copyFile(source.binary, binary);
    if (await hash(binary) !== digest) throw new Error('The candidate binary differs from the selected source build.');
    for (const [name, expected] of Object.entries(licenses)) {
      const file = path.join(stage, name);
      await fs.copyFile(path.join(sourceDirectory, name), file);
      if (await hash(file) !== expected) throw new Error('The candidate license differs from the pinned upstream release.');
    }
    // Sign the exact child before packing app.asar. Re-signing it afterward
    // would change the bytes the supervisor is required to authenticate.
    sign(['--force', '--sign', '-', '--options', 'runtime', '--timestamp=none', '--identifier', 'com.chicory.desktop.floresta-preview.florestad', binary]);
    sign(['--verify', '--strict', binary]);
    const pin = { version: 1, platform: process.platform, arch: process.arch, release: receipt.release, commit: receipt.commit,
      patches: receipt.patches, sourceBinarySha256: digest, sha256: await hash(binary) };
    const productName = 'Chicory Floresta Preview';
    const parent = path.join(root, 'release', 'floresta-preview');
    await fs.mkdir(parent, { recursive: true });
    output = await fs.mkdtemp(path.join(parent, 'build-'));
    let appPath;
    // Read the development config before overriding it. electron-builder's
    // extends merges arrays, which would retain the ordinary payment handlers.
    const base = loadYaml(await fs.readFile(path.join(root, 'build', 'electron-builder.yml'), 'utf8'));
    await build({ projectDir: root, targets: Platform.MAC.createTarget('dir'), publish: 'never', config: {
      ...base, appId: 'com.chicory.desktop.floresta-preview', productName,
      directories: { ...base.directories, output }, protocols: [], publish: null,
      extraResources: [...base.extraResources, { from: stage, to: 'runtime/floresta', filter: ['florestad', ...Object.keys(licenses)] }],
      extraMetadata: { chicoryChannel: 'floresta-preview', chicoryFlorestaPreview: pin },
      mac: { ...base.mac, identity: '-', notarize: false, signIgnore: ['/Contents/Resources/runtime/floresta/florestad$'] },
      afterSign: context => { appPath = path.join(context.appOutDir, productName + '.app'); },
    } });
    const info = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path.join(appPath, 'Contents', 'Info.plist')]));
    if (info.CFBundleIdentifier !== 'com.chicory.desktop.floresta-preview' || info.CFBundleURLTypes?.length) {
      throw new Error('The preview must have its own app identifier and leave payment links to the wallet.');
    }
    const resources = path.join(appPath, 'Contents', 'Resources');
    const metadata = JSON.parse(extractFile(path.join(resources, 'app.asar'), 'package.json'));
    const packaged = preview.previewCandidate(metadata, resources);
    if (packaged?.sha256 !== pin.sha256 || await hash(packaged.binary) !== pin.sha256) {
      throw new Error('The final packaged daemon differs from the checksum embedded in app.asar.');
    }
    for (const [name, expected] of Object.entries(licenses)) {
      if (await hash(path.join(path.dirname(packaged.binary), name)) !== expected) throw new Error('A packaged Floresta license is incorrect.');
    }
    sign(['--verify', '--strict', packaged.binary]);
    sign(['--verify', '--deep', '--strict', appPath]);
    complete = true;
    console.log(appPath);
  } finally {
    await fs.rm(stage, { recursive: true, force: true });
    if (output && !complete) await fs.rm(output, { recursive: true, force: true });
  }
}

const { values } = parseArgs({ options: { sha256: { type: 'string' } } });
await packagePreview(values.sha256);
