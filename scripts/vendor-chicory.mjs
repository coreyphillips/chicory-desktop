#!/usr/bin/env node
// Re-vendor the Chicory interface into web/chicory and web/gallery by a
// three-way merge: for every file Chicory changed between the commit
// sources.json records and the target commit, a desktop copy still equal to
// the recorded version takes the new one outright, a desktop copy that was
// adapted is merged with `git merge-file` (conflict markers are left for the
// reviewer), a new file is copied and a file Chicory deleted is deleted when
// the desktop never changed it. Tests, native platform projects and the
// embedded modules the desktop replaces are never vendored.
//
//   node scripts/vendor-chicory.mjs --to <chicory commit> [--chicory ../chicory] [--dry-run] [--record]
//   node scripts/vendor-chicory.mjs --to <chicory commit> --record-only
//
// --record writes the target commit into sources.json once the merge is clean;
// --record-only writes it without merging again (the merge is not idempotent:
// a second run would merge the already merged files once more).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const has = (name) => args.includes(name);
const chicory = path.resolve(root, flag('--chicory') ?? '../chicory');
const to = flag('--to');
if (!to) { console.error('usage: vendor-chicory.mjs --to <commit> [--chicory <path>] [--dry-run] [--record]'); process.exit(2); }
const dryRun = has('--dry-run');
const sourcesPath = path.join(root, 'sources.json');
const sources = JSON.parse(fs.readFileSync(sourcesPath, 'utf8'));

const git = (...argv) => execFileSync('git', ['-C', chicory, ...argv], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
// A path absent from a commit (a file Chicory added or deleted) is null.
const show = (commit, file) => {
  try { return execFileSync('git', ['-C', chicory, 'show', `${commit}:${file}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch { return null; }
};
const resolved = git('rev-parse', `${to}^{commit}`).trim();

// The desktop never vendors these: tests, and the embedded modules it replaces.
const EXCLUDED = [/(^|\/)__tests__\//, /\.test\.[cm]?[jt]sx?$/,
  /^src\/embedded\/(base64|iroh|network|socks|sqlite|storage)\.ts$/];
// Where a Chicory path lands in this repository, per sources.json entry.
const MAPPINGS = [
  { key: 'chicory', from: /^(src\/.+|App\.tsx|REDESIGN\.md)$/, to: (p) => path.join('web/chicory', p) },
  { key: 'chicory-gallery', from: /^native-tests\/gallery\/(.+)$/, to: (p) => path.join('web/gallery', p.replace(/^native-tests\/gallery\//, '')) },
  { key: 'chicory-gallery', from: /^test-support\/fixtures\.ts$/, to: () => 'web/gallery/fixtures.ts' },
];

const record = () => {
  for (const key of ['chicory', 'chicory-gallery']) sources[key].commit = resolved;
  fs.writeFileSync(sourcesPath, JSON.stringify(sources, null, 2) + '\n');
  console.log(`sources.json records ${resolved}`);
};
if (has('--record-only')) { record(); process.exit(0); }

const actions = { took: [], merged: [], conflicted: [], added: [], deleted: [], kept: [], skipped: [] };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vendor-chicory-'));
for (const mapping of MAPPINGS) {
  const base = sources[mapping.key].commit;
  const changed = git('diff', '--name-only', base, resolved).split('\n').filter(Boolean)
    .filter((p) => mapping.from.test(p) && !EXCLUDED.some((rx) => rx.test(p)));
  for (const file of changed) {
    const target = path.join(root, mapping.to(file));
    const theirs = show(resolved, file);
    const before = show(base, file);
    const ours = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
    const rel = path.relative(root, target);
    if (theirs === before) continue;
    if (theirs === null) {
      if (ours === null) continue;
      if (ours === before) { actions.deleted.push(rel); if (!dryRun) fs.rmSync(target); }
      else actions.kept.push(`${rel} (deleted upstream, adapted here)`);
      continue;
    }
    if (ours === null) {
      actions.added.push(rel);
      if (!dryRun) { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, theirs); }
      continue;
    }
    if (ours === theirs) continue;
    if (ours === before) { actions.took.push(rel); if (!dryRun) fs.writeFileSync(target, theirs); continue; }
    if (before === null) { actions.kept.push(`${rel} (added upstream, already present and different)`); continue; }
    const o = path.join(tmp, 'ours'), b = path.join(tmp, 'base'), t = path.join(tmp, 'theirs');
    fs.writeFileSync(o, ours); fs.writeFileSync(b, before); fs.writeFileSync(t, theirs);
    let merged; let conflicts = 0;
    try {
      merged = execFileSync('git', ['merge-file', '-p', '-L', 'desktop', '-L', `chicory ${base.slice(0, 7)}`, '-L', `chicory ${resolved.slice(0, 7)}`, o, b, t], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    } catch (err) {
      if (typeof err.status !== 'number' || err.status < 0) throw err;
      conflicts = err.status; merged = err.stdout;
    }
    (conflicts ? actions.conflicted : actions.merged).push(conflicts ? `${rel} (${conflicts} conflicts)` : rel);
    if (!dryRun) fs.writeFileSync(target, merged);
  }
}
fs.rmSync(tmp, { recursive: true, force: true });
for (const [name, list] of Object.entries(actions)) if (list.length) console.log(`${name}:\n  ${list.join('\n  ')}`);
if (has('--record') && !dryRun) {
  if (actions.conflicted.length) { console.error('conflicts remain; not recording'); process.exit(1); }
  record();
}
