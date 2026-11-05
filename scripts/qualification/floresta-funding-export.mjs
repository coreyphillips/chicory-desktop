// Export only chain bytes and public watches from the controlled regtest.
// The backup, OS keys and wallet configuration never enter this directory.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { REGTEST_GENESIS, headerHash } from './guards.mjs';
import collection from '../../desktop/floresta-wallet-sync.cjs';
import sanitize from '../../server/floresta-collection.js';

export async function readPublicWatches(child, walletId, until, restored = false) {
  const owner = createHash('sha256').update('regtest:' + walletId).digest('hex');
  const entry = await until('public channel watch export', async () => {
    const rows = await collection.snapshots(child, 'regtest', AbortSignal.timeout(10000));
    return rows.find(row => row.owner === owner);
  }, row => row?.snapshot?.status === 'observed' || (restored && row?.snapshot?.status === 'recovery-pending'));
  return { owner, snapshot: sanitize.publicSnapshot(entry.snapshot, 'regtest', { remaining: 8 * 1024 * 1024 }) };
}

export async function writeFundingFixture(directory, rpc, manifest) {
  assert.equal(rpc('getblockchaininfo').chain, 'regtest');
  assert.equal(rpc('getblockhash', 0), REGTEST_GENESIS);
  const tipHeight = rpc('getblockcount');
  const tipHash = rpc('getblockhash', tipHeight);
  assert.ok(Number.isInteger(tipHeight) && tipHeight >= 1 && tipHeight <= 4096);
  let hash = tipHash;
  let bytes = 0;
  const blocks = new Array(tipHeight + 1);
  for (let height = tipHeight; height >= 0; height--) {
    const block = rpc('getblock', hash, 0);
    assert.ok(typeof block === 'string' && block.length >= 160 && block.length % 2 === 0 && /^[a-f0-9]+$/.test(block));
    assert.equal(headerHash(block.slice(0, 160)), hash);
    bytes += block.length / 2;
    assert.ok(bytes <= 64 * 1024 * 1024, 'The funded fixture exceeds the regtest export limit');
    blocks[height] = JSON.stringify(block);
    if (!height) assert.equal(hash, REGTEST_GENESIS);
    hash = Buffer.from(block.slice(8, 72), 'hex').reverse().toString('hex');
  }
  assert.equal(rpc('getblockhash', tipHeight), tipHash);
  const options = { flag: 'wx', mode: 0o600 };
  await fs.writeFile(path.join(directory, 'blocks.ndjson'), blocks.join('\n') + '\n', options);
  await fs.writeFile(path.join(directory, 'fixture.json'), JSON.stringify({
    version: 1, network: 'regtest', tipHeight, tipHash, ...manifest
  }, null, 2) + '\n', options);
  return { tipHeight, tipHash, blockBytes: bytes, ...(manifest.restored && { restoredWatches: manifest.restored.snapshot.status }) };
}

export async function captureRestoredFunding({ directory, rpc, until, primaryId, peer, subject, recipientId, funding, payer, wallet, passphrase, stopSubject, startRestored }) {
  const live = await readPublicWatches(peer.child, primaryId, until);
  const archive = await subject.bytes('/api/backup/full/export', { passphrase });
  assert.equal(archive.subarray(0, 12).toString(), 'CHICORYFULL1');
  const later = await payer.receive(await payer.quoteReceive({ amountSats: 1000, description: 'regtest after backup' }));
  const sent = await wallet.send(await wallet.prepareSend({ request: later.bolt11 }));
  assert.notEqual(sent.status, 'failed');
  await until('payment after fixture backup settled', () => payer.getReceiveStatus(later), status => status.phase === 'completed');
  await stopSubject();
  const manager = await startRestored();
  try {
    const wallets = await manager.api('/backup/full/restore', { passphrase, archive: archive.toString('base64') });
    assert.ok(wallets.restored.some(row => row.id === recipientId));
    collection.setWatchCollection(manager.child, 'regtest', true);
    await manager.api('/wallets/' + recipientId + '/start', {});
    const rows = await until('stale restored channel held or closed', () => manager.call('/wallets/' + recipientId + '/api/channels'),
      rows => rows.some(row => row.restoreRecencyUnproven || /ERRORED|CLOS/.test(row.state)));
    assert.ok(rows.every(row => !(row.restoreRecencyUnproven && row.htlcUsable)));
    const restored = await readPublicWatches(manager.child, recipientId, until, true);
    return await writeFundingFixture(directory, rpc, {
      live, restored, liveRole: 'channel-counterparty', restoredRole: 'recipient',
      restore: { kind: 'full-backup', heldOrClosed: true, staleBy: 'one settled payment' }, ...funding
    });
  } finally {
    const exited = new Promise(resolve => {
      if (manager.child.exitCode !== null || manager.child.signalCode) resolve();
      else manager.child.once('exit', resolve);
    });
    manager.child.kill('SIGTERM');
    await exited;
  }
}
