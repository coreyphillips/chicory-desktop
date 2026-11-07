// All wallets, HTLCs and coins belong to the guarded local regtest run.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { REGTEST_GENESIS, assertRegtestWallets } from './guards.mjs';
import { readPublicWatches, writeFundingFixture } from './floresta-funding-export.mjs';

const sats = value => Math.round(value * 100000000);
const outpoint = (txid, vout) => txid + ':' + vout;
const log = label => process.stderr.write('[funded close] ' + label + '\n');

async function until(label, read, accept = Boolean, timeout = 90000) {
  log(label);
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const value = await read();
      if (accept(value)) return value;
    } catch { /* Child startup or Electrs indexing is in progress. */ }
    await delay(500);
  }
  throw new Error('Timed out waiting for ' + label);
}

export async function qualifyForceClose({ peer, primaryId, payerId, gate, rpc, fixtureDirectory, incoming = false }) {
  assert.ok(gate.verified);
  assert.equal(rpc('getblockhash', 0), REGTEST_GENESIS);
  assertRegtestWallets(await peer.api('/wallets'));
  const route = (id, endpoint, body) => peer.call('/wallets/' + id + '/api/' + endpoint, body);
  const sender = (endpoint, body) => route(primaryId, endpoint, body);
  const receiver = (endpoint, body) => route(payerId, endpoint, body);
  async function stopWallet(id) {
    await peer.api('/wallets/' + id + '/stop', {});
    await until('wallet writer stopped', () => peer.api('/wallets/' + id),
      row => row.status === 'stopped' && !row.healthy && row.desiredRunning === false);
  }
  const watch = async () => (await readPublicWatches(peer.child, primaryId, until)).snapshot;
  const receiverId = (await receiver('info')).nodeId;
  const channel = await until('active confirmed channel to the receiving wallet', async () => {
    const rows = await sender('channels');
    return rows.find(c => c.peerPubkey === receiverId && c.htlcUsable && c.localBalanceSats > 40000 &&
      rpc('gettxout', c.fundingTxid, c.fundingOutputIndex)?.confirmations > 0);
  });
  const funding = outpoint(channel.fundingTxid, channel.fundingOutputIndex);
  assert((await watch()).outpoints.some(point => point.outpoint === funding));
  const current = async () => (await sender('channels')).find(c => c.channelId === channel.channelId);
  const preimage = incoming ? randomBytes(32) : null;
  const paymentHash = preimage ? createHash('sha256').update(preimage).digest('hex') : randomBytes(32).toString('hex');
  const amountSats = 30000;
  const syncedHeight = rpc('getblockcount');
  await until('both Lightning nodes at the independent chain tip', async () => {
    const tips = await Promise.all([sender('info'), receiver('info')]);
    return tips.every(info => info.blockHeight === syncedHeight);
  });
  const invoice = await receiver('invoice/create-hold', { paymentHash, amountSats, minFinalCltvExpiry: 72, description: 'disposable recovery test' });
  const admission = await sender('invoice/pay-async', { bolt11: invoice.bolt11 });
  assert.equal(admission.status, 'PENDING');
  let lastState;
  const held = await until('committed unresolved HTLC at its recipient', async () => {
    const row = (await receiver('invoices/held')).find(item => item.paymentHash === paymentHash);
    const payment = (await sender('payments')).find(item => item.paymentHash === paymentHash);
    const state = [row?.state, row?.htlcCount, payment?.status].join(' ');
    if (lastState !== state) { log('Hold state ' + state); lastState = state; }
    return row?.htlcCount === 1 && row.heldAmountMsat === String(amountSats * 1000) && row.earliestExpiry > 0 ? row : null;
  });
  assert.equal((await current()).htlcCount, 1);
  if (incoming) {
    const { qualifyIncomingClaim } = await import('./floresta-incoming-claim.mjs');
    return qualifyIncomingClaim({ peer, senderId: primaryId, receiverId: payerId, sender, receiver, gate, rpc, fixtureDirectory,
      preimage, paymentHash, funding, channel, expiry: held.earliestExpiry, stopWallet, until });
  }
  await stopWallet(payerId);
  const before = rpc('getblockcount');
  const deadline = held.earliestExpiry + 6;
  assert(deadline > before && deadline - before <= 200);
  gate.mine(deadline - before);
  const close = await until('automatic expiry force close and its actual funding spend in Core', async () => {
    const status = (await current())?.closeStatus;
    if (status?.reason !== 'HTLC_EXPIRY_FORCE_CLOSE' || status.closer !== 'local' || !status.broadcast) return null;
    const [spend] = rpc('gettxspendingprevout', [{ txid: channel.fundingTxid, vout: channel.fundingOutputIndex }]);
    return spend.spendingtxid === status.closingTxid ? status : null;
  });
  gate.mine(1);
  const commitment = rpc('getrawtransaction', close.closingTxid, true);
  assert(commitment.vin.some(input => outpoint(input.txid, input.vout) === funding));
  const closeHeight = rpc('getblockheader', commitment.blockhash).height;
  const classified = await until('classified commitment and delayed local balance', () => current(),
    c => c.closeStatus?.confirmationHeight === closeHeight && c.closeStatus.fundsAvailableHeight > closeHeight);
  const csvHeight = classified.closeStatus.fundsAvailableHeight;
  const htlcOutput = commitment.vout.filter(output => sats(output.value) === amountSats);
  assert.equal(htlcOutput.length, 1);
  const htlcPoint = outpoint(commitment.txid, htlcOutput[0].n);
  const watching = snapshot => snapshot.outpoints.some(point => point.outpoint === htlcPoint);
  await until('live monitor watching exact commitment HTLC output', watch, watching);
  await stopWallet(primaryId);
  await peer.api('/wallets/' + primaryId + '/start', {});
  await until('reopened monitor has the same confirmed commitment and CSV maturity', () => current(),
    c => c.closeStatus?.closingTxid === commitment.txid && c.closeStatus.confirmationHeight === closeHeight &&
      c.closeStatus.fundsAvailableHeight === csvHeight && c.closeStatus.resolution === 'sweeping');
  await until('reopened monitor watching exact commitment HTLC output', watch, watching);
  assert(csvHeight - closeHeight <= 200);
  // Give the confirmed timeout a block before the two CSV delays mature.
  gate.mine(2);
  await until('closer at the confirmed commitment tip', () => sender('info'), info => info.blockHeight === closeHeight + 2);
  gate.mine(csvHeight - rpc('getblockcount'));
  await until('closer observing CSV maturity', () => sender('info'), info => info.blockHeight === csvHeight);
  // Confirm broadcasts on both sides of BIP68's earliest-valid height.
  for (let i = 0; i < 8; i++) {
    await delay(700);
    gate.mine(1);
  }
  await sender('wallet/refresh', {});
  const ready = await sender('utxos');
  const recovered = confirmSweeps({ rpc, commitment, closeHeight, csvBlocks: csvHeight - closeHeight,
    htlcPoint, expiry: held.earliestExpiry, walletCoins: ready });
  assert(recovered.balance && recovered.timeout, 'Missing a confirmed wallet sweep of the balance or HTLC timeout');
  gate.mine(101);
  const resolved = await until('all on-chain claims irrevocably resolved', () => current(),
    c => c?.state === 'CLOSED' && c.closeStatus?.resolution === 'resolved');
  if (fixtureDirectory) {
    log('Exporting the reopened monitor and public Core blocks');
    const live = await readPublicWatches(peer.child, primaryId, until);
    await writeFundingFixture(fixtureDirectory, rpc, { liveRole: 'reopened-closer', live, currentFunding: funding,
      commitmentHtlc: htlcPoint, commitmentBalance: recovered.balance.spent, secondLevel: recovered.timeout.spent,
      balanceSweep: recovered.balance.output, timeoutSweep: recovered.timeout.output,
      close: { reason: resolved.closeStatus.reason, heldSats: amountSats, expiry: held.earliestExpiry, csvBlocks: csvHeight - closeHeight } });
  }
  return { fundingSats: channel.capacitySats, heldSats: amountSats, expiryHeight: held.earliestExpiry, triggerHeight: deadline,
    cause: resolved.closeStatus.reason, closeHeight, csvHeight, reopenedMonitor: true, finalHeight: rpc('getblockcount'),
    finalState: resolved.state, ...recovered };
}

// Use Core's decoded inputs and outputs to walk only the commitment's spend
// graph. A wallet UTXO alone does not prove which contract recovered it.
function confirmSweeps({ rpc, commitment, closeHeight, csvBlocks, htlcPoint, expiry, walletCoins }) {
  const ancestry = new Map();
  for (const output of commitment.vout) ancestry.set(outpoint(commitment.txid, output.n), { origin: commitment.txid, height: closeHeight });
  const result = { balance: null, timeout: null };
  const tip = rpc('getblockcount');
  assert(tip - closeHeight <= 400);
  for (let height = closeHeight; height <= tip; height++) {
    const block = rpc('getblock', rpc('getblockhash', height), 2);
    for (const tx of block.tx) {
      for (const input of tx.vin) {
        const prev = outpoint(input.txid, input.vout);
        const ancestor = ancestry.get(prev);
        if (!ancestor) continue;
        if (prev === htlcPoint && tx.locktime === expiry) {
          for (const output of tx.vout) ancestry.set(outpoint(tx.txid, output.n), { origin: 'htlc-timeout', height, txid: tx.txid });
          continue;
        }
        // Both the primary balance and a second-level timeout wait a block
        // CSV. A fee input, anchor or counterparty sweep cannot qualify.
        if (csvBlocks < 1 || csvBlocks > 0xffff || input.sequence !== csvBlocks || height < ancestor.height + input.sequence) continue;
        for (const output of tx.vout) {
          const walletCoin = walletCoins.find(coin => coin.txid === tx.txid && coin.vout === output.n &&
            coin.height === height && coin.address === output.scriptPubKey.address && coin.valueSats === sats(output.value));
          if (!walletCoin) continue;
          const utxo = rpc('gettxout', tx.txid, output.n);
          assert(utxo?.confirmations >= 1 && utxo.scriptPubKey.hex === output.scriptPubKey.hex && utxo.value === output.value);
          const claim = { spent: prev, output: outpoint(tx.txid, output.n), height, csvBlocks: input.sequence, recoveredSats: walletCoin.valueSats };
          if (ancestor.origin === 'htlc-timeout') result.timeout = { ...claim, timeoutHeight: ancestor.height };
          else if (prev !== htlcPoint) result.balance = claim;
        }
      }
    }
  }
  return result;
}
