import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { systemTar } from './system-tar.mjs';

const defaultRoot = fileURLToPath(new URL('../../', import.meta.url));

async function verifiedDownload(url, destination, sha256) {
  let bytes;
  try { bytes = await fs.readFile(destination); } catch (cause) {
    if (cause.code !== 'ENOENT') throw cause;
    const response = await fetch(url, { signal: AbortSignal.timeout(180000) });
    if (!response.ok) throw new Error(`Tor download failed: HTTP ${response.status}.`);
    bytes = Buffer.from(await response.arrayBuffer());
  }
  if (createHash('sha256').update(bytes).digest('hex') !== sha256)
    throw new Error(`Tor checksum verification failed for ${path.basename(destination)}.`);
  await fs.writeFile(destination, bytes);
  return destination;
}

export async function verifiedSourceArchive(root, cache, source) {
  if (!source.vendored) return verifiedDownload(source.url, path.join(cache, source.file), source.sha256);
  // Keep the exact upstream recipe archive available even when GitLab blocks
  // requests from hosted CI. Its provenance and checksum remain in the manifest.
  const directory = path.resolve(root, 'build/sources');
  const file = path.resolve(root, source.vendored);
  if (!file.startsWith(directory + path.sep) || path.basename(file) !== source.file)
    throw new Error('The vendored Tor source path is outside build/sources.');
  const bytes = await fs.readFile(file);
  if (createHash('sha256').update(bytes).digest('hex') !== source.sha256)
    throw new Error(`Tor checksum verification failed for ${source.file}.`);
  return file;
}

export async function prepareTor(root = defaultRoot) {
  const runtime = path.join(root, '.runtime');
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'build/tor-manifest.json'), 'utf8'));
  const target = `${process.platform}-${process.arch}`;
  const archive = manifest.platforms[target];
  if (!archive) throw new Error(`No reviewed Tor Expert Bundle is configured for ${target}.`);
  const cache = path.join(runtime, 'downloads');
  await fs.mkdir(cache, { recursive: true });
  const archiveFile = await verifiedDownload(manifest.baseUrl + archive.file, path.join(cache, archive.file), archive.sha256);
  const sourceName = `tor-${manifest.torVersion}.tar.gz`;
  const sourceFile = await verifiedDownload(manifest.source.url, path.join(cache, sourceName), manifest.source.sha256);
  const additionalSources = await Promise.all((manifest.additionalSources || []).map(source =>
    verifiedSourceArchive(root, cache, source)));
  const stage = await fs.mkdtemp(path.join(runtime, 'tor-unpack-'));
  const destination = path.join(runtime, 'tor');
  try {
    // Windows 10/11 include bsdtar. Only the checksum-pinned archive is extracted.
    execFileSync(systemTar, ['-xzf', archiveFile, '-C', stage, 'tor', 'data', 'docs'], { stdio: 'inherit' });
    // Bridge transports are not configured by this release and are not shipped.
    await fs.rm(path.join(stage, 'tor/pluggable_transports'), { recursive: true, force: true });
    await fs.rm(path.join(stage, 'tor/tor-gencert.exe'), { force: true });
    const binary = path.join(stage, 'tor', process.platform === 'win32' ? 'tor.exe' : 'tor');
    if (process.platform === 'darwin') {
      // Upstream arm64 Tor has a stale linker signature after its reproducible
      // build. Normal local signing makes it executable before application signing.
      execFileSync('codesign', ['--force', '--sign', '-', binary], { stdio: 'inherit' });
    }
    const env = { ...process.env };
    if (process.platform === 'linux') env.LD_LIBRARY_PATH = path.join(stage, 'tor');
    delete env.LD_PRELOAD; delete env.DYLD_INSERT_LIBRARIES; delete env.DYLD_LIBRARY_PATH;
    const version = execFileSync(binary, ['--version'], { env, encoding: 'utf8' });
    if (!version.startsWith(`Tor version ${manifest.torVersion} `)) throw new Error('The bundled Tor version does not match its reviewed manifest.');
    await fs.mkdir(path.join(stage, 'source'), { recursive: true });
    await fs.copyFile(sourceFile, path.join(stage, 'source', sourceName));
    for (const source of additionalSources) await fs.copyFile(source, path.join(stage, 'source', path.basename(source)));
    await fs.copyFile(path.join(root, 'build/licenses/GPL-3.0.txt'), path.join(stage, 'docs/GPL-3.0.txt'));
    await fs.writeFile(path.join(stage, 'source/README.txt'), [
      `Tor ${manifest.torVersion}, from the official Tor Expert Bundle ${manifest.bundleVersion}.`,
      `Archive: ${manifest.baseUrl}${archive.file}`, `SHA256: ${archive.sha256}`,
      `Official checksum list: ${manifest.checksumSource}`,
      `Tor source archive included beside this notice: ${sourceName}`,
      `Source SHA256: ${manifest.source.sha256}`,
      `Upstream reproducible build recipes: ${manifest.buildRepository}/-/tree/${manifest.buildTag}`,
      `Pinned recipe commit: ${manifest.buildCommit}`,
      'The source directory also includes the pinned upstream build recipes, OpenSSL, libevent and zlib sources.',
      'Some platforms use system zlib. See the platform rules in the included upstream recipes.',
      'Source URLs and SHA256 checksums are recorded in ../bundle.json.',
      'Tor and its bundled libraries retain their upstream licenses in ../docs/.',
      'The official Tor executable identifies its combined build license as GPLv3.',
      'Chicory communicates with this separate executable through SOCKS and its control protocol.',
      '',
    ].join('\n'));
    await fs.writeFile(path.join(stage, 'bundle.json'), JSON.stringify({
      ...manifest, platform: process.platform, arch: process.arch,
      archive: archive.file, archiveSha256: archive.sha256,
    }, null, 2) + '\n');
    await fs.rm(destination, { recursive: true, force: true });
    await fs.rename(stage, destination);
    console.log(`Bundled Tor ${manifest.torVersion} verified for ${target}.`);
    return destination;
  } catch (cause) {
    await fs.rm(stage, { recursive: true, force: true });
    throw cause;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await prepareTor();
