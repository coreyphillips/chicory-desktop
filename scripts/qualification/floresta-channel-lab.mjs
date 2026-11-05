import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { grantWalletBridge } from '../../desktop/floresta-wallet-bridge.cjs';
import { REGTEST_GENESIS } from './guards.mjs';

const load = createRequire(new URL('../../server/package.json', import.meta.url));
const { address, Block, networks, opcodes, payments, script, Transaction } = load('bitcoinjs-lib');
const network = networks.regtest;
const miner = payments.p2sh({ network, redeem: { output: Buffer.from([opcodes.OP_TRUE]) } });
const executable = fileURLToPath(new URL('../../.runtime/node/' + (process.platform === 'win32' ? 'node.exe' : 'bin/node'), import.meta.url));
const hashScript = script => createHash('sha256').update(script).digest().reverse().toString('hex');
const amount = 300000;
const depositValue = 600000;

async function until(label, read, ok, timeout = 90000) {
  const end = Date.now() + timeout;
  do {
    const value = await read();
    if (ok(value)) return value;
    await delay(200);
  } while (Date.now() < end);
  throw new Error('Timed out waiting for ' + label);
}
async function port() {
  const socket = createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const { port } = socket.address();
  await new Promise(resolve => socket.close(resolve));
  return port;
}

// Compare both parties' real negotiated public keys, the exact prevout, both
// outputs and the full signed witness. The peer performs script verification.
export function reviewFunding({ proposal, left, right, deposit, opener }) {
  assert(left.temporary === right.temporary && left.local === right.remote && left.remote === right.local && left.local !== left.remote);
  assert(left.capacity === amount && right.capacity === amount);
  const pubkeys = [left.local, left.remote].map(key => { assert.match(key, /^0[23][a-f0-9]{64}$/); return Buffer.from(key, 'hex'); }).sort(Buffer.compare);
  const joint = payments.p2wsh({ network, redeem: payments.p2ms({ network, m: 2, pubkeys }) }).output;
  const signed = Transaction.fromHex(proposal.hex);
  assert.equal(signed.getId(), proposal.txid);
  assert.equal(signed.ins.length, 1);
  assert.equal(signed.outs.length, 2);
  assert.ok(signed.ins[0].hash.equals(deposit.getHash()) && signed.ins[0].index === 0);
  assert.ok(deposit.outs[0].script.equals(address.toOutputScript(opener.address, network)) && deposit.outs[0].value === depositValue);
  assert.equal(signed.ins[0].witness.length, 2);
  assert(script.isCanonicalScriptSignature(signed.ins[0].witness[0]));
  assert.equal(signed.ins[0].witness[0].at(-1), Transaction.SIGHASH_ALL);
  assert(payments.p2wpkh({ pubkey: signed.ins[0].witness[1], network }).output.equals(deposit.outs[0].script));
  assert(proposal.vout === 0 || proposal.vout === 1);
  const output = signed.outs[proposal.vout];
  assert(output.script.equals(joint) && output.value === amount);
  const change = signed.outs[1 - proposal.vout];
  assert(change.script.equals(address.toOutputScript(opener.change, network)));
  const fee = depositValue - amount - change.value;
  assert(fee >= signed.virtualSize() && fee <= signed.virtualSize() * 5 && change.value > 0);
  return { joint, txid: signed.getId(), wtxid: Buffer.from(signed.getHash(true)).reverse().toString('hex'), fee, change: change.value };
}

export async function qualifyManagedChannel({ node, proof }) {
  assert.equal(await proof('getblockhash', [0]), REGTEST_GENESIS);
  assert.equal(node.status().network, 'regtest');
  assert.equal(node.watch.walletOffersActive, true);
  assert.equal((await proof('getblockchaininfo')).bip9_softforks.segwit.status, 'active');
  const control = new AbortController();
  const children = [];
  const wallets = [];
  const owners = Array.from({ length: 2 }, () => randomBytes(32).toString('hex'));
  const log = message => process.stderr.write('[managed-channel] ' + message + '\n');
  const observe = node.onStatus;
  let previousStatus;
  node.onStatus = status => {
    observe(status);
    const current = [status.phase, status.height, status.validatedHeight, status.historicalVerification].join(' ');
    if (current !== previousStatus) { log('chain ' + current); previousStatus = current; }
  };
  const originalLifetime = node.watch.lifetime.signal;
  const revoked = () => log('native owner lease generation revoked');
  originalLifetime.addEventListener('abort', revoked, { once: true });
  function launch(name, args, extra) {
    const child = fork(fileURLToPath(new URL(name, import.meta.url)), args, { execPath: executable, execArgv: [],
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: { CHICORY_FLORESTA_WALLET_LAB: '1', BEIGNET_NETWORK: 'regtest', ...extra,
        ...(process.platform === 'win32' && { SystemRoot: process.env.SystemRoot }) } });
    children.push(child);
    return child;
  }
  const cover = (owner, tip) => until('the owner watch coverage', () => node.watchCoverage(owner), v => v.phase === 'caught-up' && v.hash === tip);
  const verified = tip => until('verified current chain status', () => node.status(), v => v.historicalVerification === 'verified' && v.tipSynced && v.tipHash === tip);
  try {
    for (const owner of owners) {
      const wallet = launch('./floresta-channel-wallet.cjs', [], { CHICORY_ELECTRUM_POLICY: 'selected-only',
        BEIGNET_ELECTRUM_TLS: 'true', BEIGNET_ELECTRUM_HOST: '127.0.0.1' });
      let sequence = 0;
      const ask = async (type, fields = {}) => {
        const id = ++sequence;
        const reply = once(wallet, 'message', { signal: AbortSignal.timeout(100000) });
        wallet.send({ id, type, ...fields });
        const [r] = await reply;
        assert.equal(r.id, id);
        if (r.error) throw new Error('Beignet channel fixture ' + type + ' ' + r.error);
        return r.value;
      };
      const keys = await ask('prepare');
      assert.equal(keys.descriptors.length, 8);
      await node.registerWatches({ owner, scripts: [], outpoints: [], descriptors: keys.descriptors.map(descriptor => ({ descriptor, range: [0, 40] })) });
      const session = node.openConfirmedWallet(owner, control.signal);
      wallets.push({ owner, ask, keys, session });
    }
    const [opener, acceptor] = wallets;
    const seed = Block.fromHex(await proof('getblock', [await proof('getblockhash', [1]), 0])).transactions[0];
    assert(seed.outs[0].script.equals(miner.output) && await proof('gettxout', [seed.getId(), 0, true]));
    const deposit = new Transaction();
    deposit.addInput(seed.getHash(), 0, 0xffffffff, script.compile([miner.redeem.output]));
    deposit.addOutput(address.toOutputScript(opener.keys.address, network), depositValue);
    deposit.addOutput(miner.output, seed.outs[0].value - depositValue - 1000);
    assert.equal(await proof('sendrawtransaction', [deposit.toHex()]), deposit.getId());
    const [tip] = await proof('generate', [1]);
    await verified(tip);
    for (const w of wallets) await cover(w.owner, tip);
    const depositHash = hashScript(deposit.outs[0].script);
    assert.equal((await opener.session.balance(depositHash)).confirmed, depositValue);
    assert.equal(await acceptor.session.history(depositHash), null);
    log('verified owner-isolated deposit, starting the two wallet transports');
    for (const w of wallets) {
      const manager = launch('./floresta-wallet-client.cjs', ['manager'], {});
      // Observe only method names and lifecycle on this fixture's own pipe.
      // Payloads can contain public wallet data or the private session key.
      const counts = new Map();
      manager.on('message', message => {
        if (message.type === 'floresta:bridge-read') counts.set(message.method, (counts.get(message.method) || 0) + 1);
        if (message.type === 'floresta:bridge-closed' && !control.signal.aborted) log('wallet bridge closed, method counts ' + JSON.stringify(Object.fromEntries(counts)));
      });
      w.lease = await grantWalletBridge({ manager, node, owner: w.owner, signal: control.signal, qualification: true });
      const start = await w.ask('start', { port: w.lease.endpoint.port, psk: w.lease.endpoint.psk });
      assert.equal(start.address, w.keys.address);
      assert.equal(start.balance, w === opener ? depositValue : 0);
      log('wallet synchronized on its own pinned endpoint');
      w.id = start.id;
      assert.match(w.id, /^0[23][a-f0-9]{64}$/);
    }
    assert.notEqual(opener.id, acceptor.id);
    assert.notEqual(opener.lease.endpoint.port, acceptor.lease.endpoint.port);
    const listen = await port();
    await acceptor.ask('listen', { port: listen });
    await opener.ask('connect', { peer: acceptor.id, port: listen });
    const temporary = await opener.ask('open', { peer: acceptor.id, amount });
    const proposal = await until('the ordinary signed and pledged funding proposal', () => opener.ask('proposal'), Boolean);
    const left = await opener.ask('negotiated'), right = await acceptor.ask('negotiated');
    assert.equal(left.temporary, temporary);
    const reviewed = reviewFunding({ proposal, left, right, deposit, opener: opener.keys });
    const { joint, txid, wtxid, fee } = reviewed;
    const [preflight] = await proof('testmempoolaccept', [[proposal.hex], 0.001]);
    assert.equal(preflight.allowed, true, preflight['reject-reason']);
    assert.equal(preflight.txid, txid);
    assert.deepEqual(await proof('getrawmempool'), []);
    await assert.rejects(opener.ask('resend'), /refused/);
    for (const w of wallets) await node.registerWatches({ owner: w.owner, scripts: [joint.toString('hex')], outpoints: [txid + ':' + proposal.vout] });
    const jointHash = hashScript(joint);
    for (const w of wallets) {
      await cover(w.owner, tip);
      const history = await w.session.history(jointHash);
      assert.equal(history.tipHash, tip);
      assert.deepEqual(history.rows, []);
    }
    log('both owners covered the reviewed funding at the same tip, releasing the BOLT negotiation');
    opener.lease.authorizeBroadcast(txid, wtxid);
    assert.throws(() => opener.lease.authorizeBroadcast(txid, wtxid));
    assert.equal(await opener.ask('release', { txid }), true);
    const records = await until('both engines to persist the fully signed funding attempt',
      () => Promise.all(wallets.map(w => w.ask('signed-record'))), records => records.every(Boolean));
    for (const record of records) assert.deepEqual(record, { txid, wtxid });
    // The last external witness completes the opener's local v2 record. The
    // receiver lacks the input owner's consent. Use the opener's real funding
    // provider to publish exactly what both BOLT state machines accepted.
    const automatic = (await proof('getrawmempool')).includes(txid);
    if (!automatic) assert.equal(await opener.ask('publish', { txid }), txid);
    await until('the independent peer to accept the channel funding', () => proof('getrawmempool'), v => v.includes(txid));
    assert.equal(await proof('getrawtransaction', [txid, 0]), proposal.hex);
    await assert.rejects(opener.ask('resend'), /refused/);
    log('independent peer accepted exact signed funding, mining confirmations');
    const blocks = [];
    while (blocks.length < 6) {
      const [block] = await proof('generate', [1]);
      blocks.push(block);
      await verified(block);
      for (const w of wallets) await cover(w.owner, block);
      assert(!originalLifetime.aborted, 'The managed node revoked the original owner lease.');
    }
    const confirmedTip = blocks.at(-1);
    for (const w of wallets) {
      await cover(w.owner, confirmedTip);
      const checked = await w.session.transaction(txid);
      assert.equal(checked.hex, proposal.hex);
      assert.equal(checked.blockHash, blocks[0]);
      assert.equal((await w.session.balance(jointHash)).confirmed, amount);
    }
    const channels = () => Promise.all(wallets.map(async w => (await w.ask('channels'))[0]));
    let lastStates;
    const ready = await until('both non-zero-conf channels to become usable', channels, pair => {
      const states = pair.map(c => c?.state || 'unavailable').join(', ');
      if (states !== lastStates) { log('confirmed funding, channel states ' + states); lastStates = states; }
      return pair.every(c => c?.htlcUsable && c.state === 'NORMAL');
    });
    assert.equal(ready[0].channelId, ready[1].channelId);
    for (const c of ready) { assert.equal(c.fundingTxid, txid); assert.equal(c.capacitySats, amount); }
    const fundingHeight = await proof('getblockcount') - 5;
    const funding = { txid, wtxid, vout: proposal.vout, value: amount, scriptHash: jointHash };
    log('stopping the managed daemon with both funded Lightning peers still live');
    await node.stop();
    assert(originalLifetime.aborted);
    for (const w of wallets) {
      await assert.rejects(w.session.transaction(txid));
      await assert.rejects(w.lease.reopenConfirmedFunding(funding));
      await until('closed authenticated wallet transport', () => w.ask('lease-status'), v => v.disconnected);
      assert.throws(() => w.lease.authorizeBroadcast(txid, wtxid));
    }
    const [absentTip] = await proof('generate', [1]);
    await node.start();
    await verified(absentTip);
    for (const w of wallets) {
      await cover(w.owner, absentTip);
      const prior = w.lease;
      await assert.rejects(prior.reopenConfirmedFunding({ ...funding, value: amount + 1 }));
      w.lease = await prior.reopenConfirmedFunding(funding);
      assert.notEqual(w.lease.endpoint.psk, prior.endpoint.psk);
      assert.throws(() => w.lease.authorizeBroadcast(txid, wtxid));
      await assert.rejects(prior.reopenConfirmedFunding(funding));
      assert.deepEqual(await w.ask('renew', { previous: prior.endpoint.psk, next: w.lease.endpoint.psk,
        port: w.lease.endpoint.port, funding: w.lease.funding }), { reconciled: true, txid });
      const resumed = await w.ask('lease-status');
      assert.equal(resumed.disconnected, false);
      assert.equal(resumed.witnessSignatures, w === opener ? 1 : 0);
      await assert.rejects(w.session.transaction(txid));
    }
    await assert.rejects(opener.ask('resend'), /refused/);
    assert.deepEqual(await proof('getrawmempool'), []);
    const [nextTip] = await proof('generate', [1]);
    await verified(nextTip);
    const nextHeight = await proof('getblockcount');
    for (const w of wallets) {
      await until('live Lightning watcher on the renewed grant', () => w.ask('lease-status'), v => v.height === nextHeight);
    }
    assert.deepEqual(await channels(), ready);
    log('both channels are usable, exercising BOLT11 payments and cancellation');
    async function transfer(from, to, sats) {
      const invoice = await to.ask('invoice', { amount: sats });
      const sent = await from.ask('pay', { bolt11: invoice.bolt11 });
      assert.equal(sent.paymentHash, invoice.hash);
      await until('both settled payment records', () => Promise.all([from, to].map(w => w.ask('payments', { hash: invoice.hash }))),
        list => list.every((rows, i) => rows.some(row => row.status === 'COMPLETED' && row.direction === (i === 0 ? 'OUTGOING' : 'INCOMING') && row.amountSats === sats)));
    }
    await transfer(opener, acceptor, 40000);
    await transfer(acceptor, opener, 12000);
    const beforeHold = await until('the two paid directions to reconcile', channels, pair => pair[1].localBalanceSats === 28000 && pair.every(c => c.htlcCount === 0));
    const hold = await acceptor.ask('invoice', { amount: 5000, hold: true });
    assert.equal((await opener.ask('pay', { bolt11: hold.bolt11 })).paymentHash, hold.hash);
    const held = await until('a parked held HTLC', () => acceptor.ask('hold', { hash: hold.hash }), h => h?.state === 'ACCEPTED' && h.count === 1 && h.held === '5000000' && h.expiry > 0);
    assert((await opener.ask('payments', { hash: hold.hash })).some(row => row.status === 'PENDING'));
    assert.equal(await acceptor.ask('cancel', { hash: hold.hash }), 1);
    const cancelled = await acceptor.ask('hold', { hash: hold.hash });
    assert.equal(cancelled.state, 'CANCELLED');
    assert.equal(cancelled.count, 0);
    await until('payer to recover its held HTLC', () => opener.ask('payments', { hash: hold.hash }), rows => rows.some(row => row.status === 'FAILED'));
    const afterHold = await until('canceled HTLC to release both channel balances', channels, pair => pair.every((c, i) =>
      c.htlcCount === 0 && c.localBalanceSats === beforeHold[i].localBalanceSats && c.remoteBalanceSats === beforeHold[i].remoteBalanceSats));
    assert.deepEqual(afterHold, beforeHold);
    const unspent = await proof('gettxout', [txid, proposal.vout, true]);
    assert.equal(Math.round(unspent.value * 1e8), amount);
    assert.equal(unspent.scriptPubKey.hex, joint.toString('hex'));
    return { network: 'regtest', twoPrivateOwnerSessions: true, sharedFundingCoveredBeforeRelease: true, channelFundingTxid: txid, wtxid,
      channelCapacitySats: amount, fundingFeeSats: fee, fundingHeight, registeredOwnerCount: 2,
      renewedOwners: 2, reconnectAfterDaemonRestart: true, restoredWatcherHeight: nextHeight, repeatedFundingSignatures: 0, renewedBroadcastAuthority: false,
      protocol: 'BOLT 2 v2', publisher: automatic ? 'automatic' : 'opener signed-record provider', rejectedUnapprovedAndRepeatedBroadcast: true, openerPaidSats: 40000, acceptorPaidSats: 12000, holdCanceledSats: 5000,
      restoredBalances: true, confirmedUnspentFunding: true, heldExpiry: held.expiry, coldPendingCoverage: 'observed-only' };
  } finally {
    node.onStatus = observe;
    originalLifetime.removeEventListener('abort', revoked);
    control.abort();
    for (const w of wallets) { w.lease?.close(); w.session.close(); }
    await Promise.all(children.map(async child => {
      if (child.exitCode !== null || child.signalCode) return;
      const end = once(child, 'exit');
      if (child.connected) child.disconnect();
      const timer = setTimeout(() => child.kill(), 2500);
      try { await end; } finally { clearTimeout(timer); }
    }));
  }
}
