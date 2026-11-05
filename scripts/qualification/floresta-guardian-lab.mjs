// Fund and recover only a newly generated regtest channel. Seeds and
// guardian entries never enter reports. Stop the original before importing.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { REGTEST_GENESIS, assertRegtestWallets } from './guards.mjs';
import collection from '../../desktop/floresta-wallet-sync.cjs';
import { readPublicWatches, writeFundingFixture } from './floresta-funding-export.mjs';

const walletRoute = (manager, id, path, body) => manager.call('/wallets/' + id + '/api/' + path, body);
const fundedPoint = row => row.fundingTxid + ':' + row.fundingOutputIndex;
const log = text => process.stderr.write('[remote recovery] ' + text + '\n');
class RecoveryTimeout extends Error {}

// Recovery status may contain guardian locators. A timeout reports just the
// step that failed, never the last response, descriptor or engine log.
async function until(label, read, accept = Boolean, timeout = 90000) {
  log(label);
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const result = await read();
      if (accept(result)) return result;
    } catch { /* The daemon can be starting or restoring. */ }
    await delay(700);
  }
  throw new RecoveryTimeout('Timed out waiting for ' + label);
}

async function stopManager(manager) {
  if (manager.child.exitCode !== null || manager.child.signalCode) return;
  const exited = once(manager.child, 'exit');
  manager.child.kill('SIGTERM');
  await exited;
}

async function stopWallet(manager, id) {
  await manager.api('/wallets/' + id + '/stop', {});
  await until('encrypted wallet stopped', () => manager.api('/wallets/' + id),
    r => r.desiredRunning === false && r.status === 'stopped' && r.healthy === false);
}

async function hostedGuardians(peer) {
  const entries = [];
  for (let i = 0; i < 3; i++) {
    const { record } = await peer.api('/wallets', { name: 'Qualification guardian ' + (i + 1), network: 'regtest',
      guardianServe: true, networkMode: 'clearnet', publicHost: '127.0.0.1' });
    const status = await until('a hosted fixture guardian to listen', () => walletRoute(peer, record.id, 'guardian/status'), value => value.serving === true);
    const candidates = await peer.api('/guardians/candidates');
    const local = candidates.find(g => g.id === record.id && g.running && g.network === 'regtest');
    assert.match(local.localUri, /^[a-f0-9]{66}@127\.0\.0\.1:[1-9][0-9]{1,4}$/);
    const resolved = await peer.api('/recovery/resolve-guardian', { uri: local.localUri });
    assert.equal(resolved.guardianId, status.guardianId);
    assert.equal(resolved.entry, resolved.guardianId + '@bolt8://' + local.localUri);
    entries.push(resolved.entry);
  }
  assert.equal(new Set(entries.map(entry => entry.split('@')[0])).size, 3);
  return entries;
}

async function watchFor(manager, id, point, scriptHex) {
  const { snapshot } = await readPublicWatches(manager.child, id, until, true);
  assert.equal(snapshot.coverageComplete, false);
  if (snapshot.status === 'observed') {
    const expected = createHash('sha256').update(Buffer.from(scriptHex, 'hex')).digest().reverse().toString('hex');
    assert.ok(snapshot.outpoints.some(item => item.outpoint === point && item.scriptHash === expected), 'Missing verified funding outpoint and script hash.');
    assert.ok(snapshot.scripts.includes(scriptHex), 'Missing the public funding script.');
  } else assert.equal(snapshot.status, 'recovery-pending');
  return snapshot.status;
}

// Wallet state can close a stale channel during reestablishment. Locate the
// actual input in Core independently of either wallet's channel state.
function spender(rpc, txid, vout, startHeight) {
  const [pool] = rpc('gettxspendingprevout', [{ txid, vout }]);
  const spends = tx => tx.vin.some(input => input.txid === txid && input.vout === vout);
  if (pool?.spendingtxid) {
    const tx = rpc('getrawtransaction', pool.spendingtxid, true);
    if (spends(tx)) return tx.txid;
  }
  const height = rpc('getblockcount');
  assert.ok(height - startHeight <= 64);
  for (let h = startHeight; h <= height; h++) {
    const tx = rpc('getblock', rpc('getblockhash', h), 2).tx.find(spends);
    if (tx) return tx.txid;
  }
  return null;
}

// An unexpected HTTP or assertion error can include an entire response. The
// report needs the failed check, never a guardian locator or backup material.
export async function qualifyRemoteRecovery(options) {
  try { return await runRecovery(options); }
  catch (error) {
    if (error instanceof RecoveryTimeout) throw error;
    const line = error.stack?.match(/floresta-guardian-lab\.mjs:(\d+):\d+/)?.[1];
    throw new Error('Remote recovery check failed' + (line ? ' at floresta-guardian-lab.mjs line ' + line : '') + '.');
  }
}

async function runRecovery({ mode, peer, primary, primaryUri, payer, gate, rpc, startReplacement, fixtureDirectory }) {
  assert.ok(gate.verified);
  assert.ok(['quorum', 'peer-storage'].includes(mode));
  assert.equal(rpc('getblockhash', 0), REGTEST_GENESIS);
  assertRegtestWallets(await peer.api('/wallets'));
  assert.match(primaryUri, /^[a-f0-9]{66}@127\.0\.0\.1:[1-9][0-9]{1,4}$/);
  const [pubkey, port] = primaryUri.split('@127.0.0.1:');
  collection.setWatchCollection(peer.child, 'regtest', true);
  const guardians = mode === 'quorum' ? await hostedGuardians(peer) : [];
  if (guardians.length) await peer.api('/settings', { recoveryGuardians: guardians }, 'PUT');
  log('Starting a fresh ' + mode + ' wallet');
  const created = await peer.api('/wallets', { name: 'Disposable protected wallet', network: 'regtest', recoveryMode: mode,
    networkMode: 'clearnet', publicHost: '127.0.0.1', lfbw: { enabled: true, primaryWalletId: primary.id, initialChannelSats: 200000 } });
  const id = created.record.id;
  assert.equal(typeof created.mnemonic, 'string');
  const original = name => walletRoute(peer, id, name);
  const active = await until('original writer ownership', () => original('recovery/status'),
    s => s.mode === mode && s.state === 'running' && (mode !== 'quorum' || s.node?.gate === 'confirmed'));
  await until('lightning-first setup', () => peer.api('/wallets/' + id), r => r.healthy && r.lfbw?.setup === 'ready');
  const channel = await until('active, independently confirmed channel', async () => {
    const rows = await original('channels');
    const row = rows.find(c => c.htlcUsable && /^[a-f0-9]{64}$/.test(c.fundingTxid) && Number.isInteger(c.fundingOutputIndex));
    if (row && rpc('getrawtransaction', row.fundingTxid, true).confirmations > 0) return row;
    gate.mine(1);
    return null;
  });
  const point = fundedPoint(channel);
  const proof = rpc('gettxout', channel.fundingTxid, channel.fundingOutputIndex);
  assert.ok(proof?.confirmations > 0);
  const fundedSats = Math.round(proof.value * 100000000);
  assert.equal(fundedSats, 200000);
  const scriptHex = proof.scriptPubKey.hex;
  assert.equal(await watchFor(peer, id, point, scriptHex), 'observed');
  const writer = peer.client(id);
  const invoice = await writer.receive(await writer.quoteReceive({ amountSats: 12000, description: 'protected regtest transfer' }));
  const sent = await payer.send(await payer.prepareSend({ request: invoice.bolt11 }));
  assert.notEqual(sent.status, 'failed');
  await until('settled payment before losing the writer', () => writer.getReceiveStatus(invoice), value => value.phase === 'completed');
  const fundedHeight = rpc('getblockcount');
  const completed = rows => rows.find(row => row.paymentHash === invoice.paymentHash && row.direction === 'INCOMING' && row.status === 'COMPLETED');
  assert.ok(completed(await original('payments')));
  const primaryRows = await walletRoute(peer, primary.id, 'channels');
  assert.ok(primaryRows.some(row => fundedPoint(row) === point));
  const before = await original('recovery/status');
  if (mode === 'quorum') assert.ok(BigInt(before.node.lastDurableSequence) > 0n);
  await stopWallet(peer, id);
  log('Original writer stopped; restoring into a fresh encrypted manager');
  const restored = await startReplacement();
  try {
    assert.deepEqual(await restored.api('/wallets'), []);
    if (guardians.length) await restored.api('/settings', { recoveryGuardians: guardians }, 'PUT');
    collection.setWatchCollection(restored.child, 'regtest', true);
    const { record } = await restored.api('/wallets/import', { name: 'Freshly recovered wallet', network: 'regtest', recoveryMode: mode,
      mnemonic: created.mnemonic, networkMode: 'clearnet', publicHost: '127.0.0.1' });
    const route = (name, body) => walletRoute(restored, record.id, name, body);
    let result;
    let held;
    if (mode === 'quorum') {
      const waiting = await until('guardian takeover required', () => route('recovery/status'), s => s.state === 'restore-required');
      assert.equal(waiting.node, null);
      await assert.rejects(route('channels'));
      held = await watchFor(restored, record.id, point, scriptHex);
      assert.equal(held, 'recovery-pending');
      await assert.rejects(route('recovery/restore', {}));
      result = await route('recovery/restore', { confirm: true });
      assert.equal(result.exact, true);
      assert.ok(result.framesApplied > 0);
      assert.ok(BigInt(result.epoch) >= 2n);
    } else {
      await until('empty peer-storage wallet', () => route('recovery/status'), s => s.mode === mode && s.state === 'running');
      assert.deepEqual(await route('channels'), []);
      await route('peer/connect', { pubkey, host: '127.0.0.1', port: Number(port) });
      const stored = await until('an authentic replica from the funding counterparty', () => route('recovery/status'),
        s => s.capsules?.best?.fromPeer === pubkey && s.capsules.best.channelCount > 0);
      assert.ok(stored.capsules.candidates > 0);
      await assert.rejects(route('recovery/restore-capsule', {}));
      result = await route('recovery/restore-capsule', { confirm: true });
      assert.equal(result.tier, 2, 'Need a complete inline channel replica');
      assert.equal(result.restartRequired, true);
      const paused = await route('recovery/status');
      assert.equal(paused.state, 'restart-required');
      await assert.rejects(route('channels'));
      assert.equal(await watchFor(restored, record.id, point, scriptHex), 'recovery-pending');
      held = paused.state;
      await stopWallet(restored, record.id);
      await restored.api('/wallets/' + record.id + '/start', {});
    }
    log('Verifying recovered funding and public watch safety');
    const status = await until('restored recovery status', () => route('recovery/status'),
      s => s.mode === mode && s.state === 'running' && (mode !== 'quorum' || s.node?.gate === 'confirmed'));
    const saved = await until('the exact funded channel in the replacement database', () => route('channels'),
      rows => rows.some(row => fundedPoint(row) === point));
    const recoveredChannel = saved.find(row => fundedPoint(row) === point);
    if (recoveredChannel.restoreRecencyUnproven) assert.notEqual(recoveredChannel.htlcUsable, true);
    const publicWatch = await watchFor(restored, record.id, point, scriptHex);
    const coin = rpc('gettxout', channel.fundingTxid, channel.fundingOutputIndex);
    const restoredPayment = Boolean(completed(await route('payments')));
    let chainOutcome = 'funding-unspent';
    let spendingId = null;
    if (mode === 'quorum' || coin) {
      assert.equal(coin?.value, proof.value);
      if (mode === 'quorum') assert.equal(restoredPayment, true);
    } else {
      spendingId = spender(rpc, channel.fundingTxid, channel.fundingOutputIndex, fundedHeight);
      assert.match(spendingId, /^[a-f0-9]{64}$/);
      gate.mine(1);
      await until('confirmed funding spend and unusable restored channel', async () => {
        const channels = await route('channels');
        const row = channels.find(item => fundedPoint(item) === point);
        return rpc('getrawtransaction', spendingId, true).confirmations >= 1 &&
          (!row || (row.htlcUsable !== true && (row.restoreRecencyUnproven || /CLOS|ERR/.test(row.state))));
      });
      chainOutcome = 'confirmed-spend-channel-unusable';
    }
    if (fixtureDirectory) {
      log('Exporting public watches and independently verified regtest blocks');
      const live = await readPublicWatches(peer.child, primary.id, until);
      const recovered = await readPublicWatches(restored.child, record.id, until);
      await writeFundingFixture(fixtureDirectory, rpc, {
        live, liveRole: 'channel-counterparty', restored: recovered, restoredRole: 'recipient',
        currentFunding: point, confirmedSpend: spendingId,
        restore: { kind: mode, chainOutcome, restoredPayment, fundedSats }
      });
    }
    let oldWriterGate = null;
    if (mode === 'quorum') {
      await stopWallet(restored, record.id);
      await stopManager(restored);
      await stopWallet(peer, primary.id);
      await peer.api('/wallets/' + id + '/start', {});
      const stale = await until('previous guardian writer fenced', () => original('recovery/status'),
        s => s.state === 'fenced' && s.node?.gate === 'fenced');
      oldWriterGate = stale.node.gate;
      assert.equal(await watchFor(peer, id, point, scriptHex), 'recovery-pending');
      await assert.rejects(walletRoute(peer, id, 'channel/forceclose', { channelId: channel.channelId }), /fenced/i);
      assert.equal(rpc('gettxout', channel.fundingTxid, channel.fundingOutputIndex)?.value, proof.value);
      await stopWallet(peer, id);
    }
    return { network: 'regtest', mode, guardianCount: guardians.length, oldState: active.state, originalStopped: true,
      originalFundingConfirmed: true, fundedSats, protectedPaymentSats: 12000, restoreHold: held, recoveredState: status.state,
      gate: status.node.gate, exact: result.exact ?? null, epoch: result.epoch ?? null, tier: result.tier ?? null,
      publicWatch, fundingOutpointVerified: true, fundingScriptVerified: true, chainOutcome, restoredPayment, oldWriterGate, localHandoff: false };
  } finally { await stopManager(restored); }
}
