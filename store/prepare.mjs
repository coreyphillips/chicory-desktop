import { parseArgs } from 'node:util';
import { mkdir, readFile, readdir, writeFile, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { values } = parseArgs({ options: {
  version: { type: 'string' }, image: { type: 'string' },
  digest: { type: 'string' }, out: { type: 'string' },
} });
const { version, image, digest, out } = values;
if (!/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/.test(version || '')) throw new Error('Supply --version as a release version.');
if (!/^ghcr\.io\/coreyphillips\/chicory-umbrel:[a-zA-Z0-9_.-]+$/.test(image || '')) throw new Error('Supply the published Chicory GHCR image and tag.');
if (image.split(':').at(-1) !== version) throw new Error('Image tag must match the app version.');
if (!/^sha256:[a-f0-9]{64}$/.test(digest || '')) throw new Error('Supply a verified SHA-256 image digest.');
if (!out) throw new Error('Supply --out as an empty release directory.');
const target = path.resolve(out);
await mkdir(target, { recursive: true });
if ((await readdir(target)).length) throw new Error('Release output directory must be empty.');
const source = path.dirname(fileURLToPath(import.meta.url));
await mkdir(path.join(target, 'chicory-wallet'));
await copyFile(path.join(source, 'umbrel-app-store.yml'), path.join(target, 'umbrel-app-store.yml'));
await copyFile(path.join(source, 'chicory-wallet', 'torrc.template'), path.join(target, 'chicory-wallet', 'torrc.template'));
for (const name of ['docker-compose.yml', 'umbrel-app.yml']) {
  const template = await readFile(path.join(source, 'chicory-wallet', `${name}.in`), 'utf8');
  await writeFile(path.join(target, 'chicory-wallet', name), template
    .replaceAll('__IMAGE__', image).replaceAll('__DIGEST__', digest).replaceAll('__VERSION__', version));
}
console.log(`Prepared Chicory ${version} in ${target}. Verify image access and finish listing assets before publishing.`);
