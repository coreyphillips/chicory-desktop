// Simulate a dishonest counterparty on fresh regtest. Only the counterparty
// holds its fixture seed. Neither real wallet has a duplicate process or DB.
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { assertRegtestWallets, REGTEST_GENESIS } from './guards.mjs';
import { readPublicWatches, writeFundingFixture } from './floresta-funding-export.mjs';

const bitcoin = createRequire(new URL('../../server/package.json', import.meta.url))('bitcoinjs-lib');
const { opcodes, script } = bitcoin;
const digest = (name, bytes) => createHash(name).update(bytes).digest();
const sat = value => Math.round(value * 100000000);
const point = (txid, vout) => txid + ':' + vout;
const log = label => process.stderr.write('[breach] ' + label + '\n');
async function until(label, read, accept = Boolean, timeout = 90000) {
  log(label);
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { const value = await read(); if (accept(value)) return value; } catch (error) {
      if (/^Counterparty [a-z-]+ failed at line (?:\d+|unknown)$/.test(error.message)) throw error;
    }
    await delay(500);
  }
  throw new Error('Timed out waiting for ' + label);
}

// Distinguish the two actual BOLT 3 penalty paths from the ordinary delayed
// and preimage spends. Core independently enforces the transaction signatures.
export function penaltyWitness(input, previous) {
  if (input.txinwitness?.length !== 3) return null;
  const [sig, selector, hex] = input.txinwitness;
  if (!/^(?:[a-f0-9]{2})+$/.test(sig) || !script.isCanonicalScriptSignature(Buffer.from(sig, 'hex'))) return null;
  const redeem = Buffer.from(hex, 'hex');
  if (previous.scriptPubKey.hex !== '0020' + digest('sha256', redeem).toString('hex')) return null;
  const words = script.decompile(redeem);
  if (!words) return null;
  if (selector === '01' && words[0] === opcodes.OP_IF && Buffer.isBuffer(words[1]) && script.isCanonicalPubKey(words[1]) &&
      words[2] === opcodes.OP_ELSE && words[4] === opcodes.OP_CHECKSEQUENCEVERIFY && words[5] === opcodes.OP_DROP &&
      Buffer.isBuffer(words[6]) && script.isCanonicalPubKey(words[6]) && words[7] === opcodes.OP_ENDIF &&
      words[8] === opcodes.OP_CHECKSIG && words.length === 9) return { type: 'delayed', pubkey: words[1].toString('hex') };
  if (/^0[23][a-f0-9]{64}$/.test(selector) && words[0] === opcodes.OP_DUP && words[1] === opcodes.OP_HASH160 &&
      words[3] === opcodes.OP_EQUAL && words[4] === opcodes.OP_IF && words[5] === opcodes.OP_CHECKSIG &&
      words[6] === opcodes.OP_ELSE && Buffer.isBuffer(words[2]) &&
      words[2].equals(digest('ripemd160', digest('sha256', Buffer.from(selector, 'hex'))))) return { type: 'htlc', pubkey: selector };
  return null;
}

export async function qualifyBreach({ peer, primaryId, primaryUri, gate, rpc, electrum, runtime, fixtureDirectory }) {
  assert(gate.verified && rpc('getblockhash', 0) === REGTEST_GENESIS && rpc('getblockchaininfo').chain === 'regtest');
  assertRegtestWallets(await peer.api('/wallets'));
  assert.equal(electrum.host, '127.0.0.1');
  const wallet = (method, body) => peer.call('/wallets/' + primaryId + '/api/' + method, body);
  assert.equal((await wallet('info')).network, 'regtest');
  const attacker = fork(fileURLToPath(new URL('./floresta-breach-counterparty.cjs', import.meta.url)), [], {
    execPath: path.join(runtime, 'node', process.platform === 'win32' ? 'node.exe' : 'bin/node'), cwd: runtime,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: { CHICORY_BREACH_LAB: '1', BEIGNET_NETWORK: 'regtest',
      CHICORY_ELECTRUM_POLICY: 'selected-only', BEIGNET_ELECTRUM_HOST: '127.0.0.1', BEIGNET_ELECTRUM_PORT: String(electrum.port), BEIGNET_ELECTRUM_TLS: 'false' } });
  const call = async (action, data = {}) => {
    const reply = once(attacker, 'message', { signal: AbortSignal.timeout(30000) });
    attacker.send({ action, ...data });
    const [message] = await reply;
    if (message.failed) throw new Error('Counterparty ' + action + ' failed at line ' + message.line);
    return message.result;
  };
  const stopAttacker = async () => {
    if (attacker.exitCode !== null || attacker.signalCode) return;
    const exited = once(attacker, 'exit');
    attacker.kill();
    await exited;
  };
  try {
    const nodeId = await call('start', { peerUri: primaryUri });
    await wallet('wallet/refresh', {});
    await wallet('channel/open', { pubkey: nodeId, amountSats: 400000 });
    const lookup = async () => (await wallet('channels')).find(row => row.peerPubkey === nodeId);
    let priorState;
    const startHeight = rpc('getblockcount');
    const channel = await until('confirmed active disposable channel', async () => {
      const row = await lookup();
      if (row?.state !== priorState) { log('Funding state ' + row.state); priorState = row.state; }
      if (row?.htlcUsable && rpc('gettxout', row.fundingTxid, row.fundingOutputIndex)?.confirmations > 0) return row;
      if (rpc('getblockcount') < startHeight + 12) gate.mine(1);
    });
    const funding = point(channel.fundingTxid, channel.fundingOutputIndex);
    const beginHeight = rpc('getblockcount');
    await until('honest node synchronized', () => wallet('info'), info => info.blockHeight === beginHeight);
    const invoice = await call('fund-invoice');
    await wallet('invoice/pay', { bolt11: invoice, timeoutMs: 30000 });
    const held = await call('hold-invoice');
    assert.equal((await wallet('invoice/pay-async', { bolt11: held.bolt11 })).status, 'PENDING');
    const captured = await until('counterparty built its still-current signed HTLC commitment',
      () => call('capture', { channelId: channel.channelId }));
    assert(await call('settle'));
    await until('held HTLC settled before revocation', () => wallet('payments'), rows =>
      rows.some(p => p.paymentHash === held.paymentHash && p.direction === 'OUTGOING' && p.status === 'COMPLETED'));
    const former = await until('later durable commitment replaces the captured state', () => call('release'));
    assert(BigInt(former.current) > BigInt(captured.number));
    await stopAttacker();
    await peer.api('/wallets/' + primaryId + '/stop', {});
    await until('honest wallet offline before breach', () => peer.api('/wallets/' + primaryId),
      row => !row.healthy && row.status === 'stopped' && row.desiredRunning === false);
    // A single recorded synthetic outpoint on the chain just verified. Never
    // submit operator-supplied bytes, and never send through a wallet relay.
    assert.equal(rpc('getblockhash', 0), REGTEST_GENESIS);
    const tx = rpc('decoderawtransaction', former.hex);
    assert.equal(tx.txid, captured.txid);
    assert.equal(tx.vin.length, 1);
    assert.equal(point(tx.vin[0].txid, tx.vin[0].vout), funding);
    assert.equal(sat(rpc('gettxout', channel.fundingTxid, channel.fundingOutputIndex).value), 400000);
    const [admitted] = rpc('testmempoolaccept', [former.hex]);
    assert.equal(admitted.allowed, true, 'Bitcoin Core must validate the independently captured former commitment');
    assert.equal(rpc('sendrawtransaction', former.hex), tx.txid);
    gate.mine(1);
    const confirmedBreach = rpc('getrawtransaction', tx.txid, true);
    assert(confirmedBreach.confirmations >= 1);
    const breachHeight = rpc('getblockheader', confirmedBreach.blockhash).height;
    await peer.api('/wallets/' + primaryId + '/start', {});
    await until('honest restarted monitor classifies remote commitment', lookup,
      row => row.closeStatus?.closer === 'remote' && row.closeStatus.closingTxid === tx.txid &&
        row.closeStatus.confirmationHeight === breachHeight);
    const claims = await until('both revocation spends admitted by Core', async () => {
      const observed = {};
      const children = rpc('getrawmempool').map(id => rpc('getrawtransaction', id, true));
      for (const child of children) for (const input of child.vin) {
        if (input.txid !== tx.txid) continue;
        const prev = tx.vout[input.vout];
        const witness = penaltyWitness(input, prev);
        if (witness) observed[witness.type] = { pubkey: witness.pubkey, txid: child.txid, prev: point(tx.txid, input.vout), value: sat(prev.value) };
      }
      return observed.delayed && observed.htlc ? observed : null;
    });
    assert.equal(claims.htlc.value, 30000);
    assert.equal(claims.delayed.pubkey, claims.htlc.pubkey);
    gate.mine(1);
    const justiceHeight = rpc('getblockcount');
    const payouts = [];
    for (const id of new Set([claims.delayed.txid, claims.htlc.txid])) {
      const justice = rpc('getrawtransaction', id, true);
      assert.equal(justice.confirmations, 1);
      assert.equal(justice.vout.length, 1);
      const output = justice.vout[0];
      const coin = await until('verified penalty credited to honest wallet', async () => {
        await wallet('wallet/refresh', {});
        return (await wallet('utxos')).find(c => c.txid === id && c.vout === 0 &&
          c.address === output.scriptPubKey.address && c.valueSats === sat(output.value) && c.height === justiceHeight);
      });
      assert.equal(rpc('gettxout', id, 0).value, output.value);
      payouts.push({ point: point(id, 0), value: coin.valueSats });
    }
    gate.mine(101);
    await until('irrevocable breach resolution', lookup, row => row?.state === 'CLOSED' && row.closeStatus?.resolution === 'resolved');
    const result = { network: 'regtest', initialCommitment: captured.number, laterCommitment: former.current,
      fundingSats: channel.capacitySats, breachHeight, justiceHeight, finalHeight: rpc('getblockcount'),
      delayedSats: claims.delayed.value, htlcSats: claims.htlc.value, recoveredSats: payouts.reduce((sum, row) => sum + row.value, 0),
      justiceTransactions: payouts.length, restarted: true, resolved: true };
    if (fixtureDirectory) {
      const live = await readPublicWatches(peer.child, primaryId, until);
      await writeFundingFixture(fixtureDirectory, rpc, { live, liveRole: 'justice-monitor', currentFunding: funding,
        revokedBalance: claims.delayed.prev, revokedHtlc: claims.htlc.prev, payouts, breach: result });
    }
    return result;
  } finally { await stopAttacker(); }
}
