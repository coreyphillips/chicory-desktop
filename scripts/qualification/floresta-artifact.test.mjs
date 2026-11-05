import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { publishCandidate } from '../desktop/prepare-floresta.mjs';

test('reusing a prepared digest verifies the complete payload without replacing a modified installation', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chicory-artifact-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const installed = path.join(root, 'installed');
  const stage = async () => {
    const dir = await fs.mkdtemp(path.join(root, 'stage-'));
    for (const [file, value] of [['florestad', 'release bytes'], ['bundle.json', 'receipt'], ['LICENSE', 'license']]) {
      await fs.writeFile(path.join(dir, file), value, { mode: 0o700 });
    }
    return dir;
  };
  await publishCandidate(await stage(), installed);
  const identical = await stage();
  await publishCandidate(identical, installed);
  const receipt = path.join(installed, 'bundle.json');
  await fs.writeFile(receipt, 'changed');
  await assert.rejects(publishCandidate(identical, installed), /differs/);
  assert.equal(await fs.readFile(receipt, 'utf8'), 'changed');
  await fs.writeFile(receipt, 'receipt');
  await fs.writeFile(path.join(installed, 'unexpected.dll'), 'extra');
  await assert.rejects(publishCandidate(identical, installed), /differs/);
});
