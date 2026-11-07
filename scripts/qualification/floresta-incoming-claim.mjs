// Disposable regtest only. Disclose the synthetic preimage through the wallet's
// settlement API. Core's independently confirmed witness is the claim evidence.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { REGTEST_GENESIS } from './guards.mjs';
import { readPublicWatches, writeFundingFixture } from './floresta-funding-export.mjs';

const { script, opcodes: op } = createRequire(new URL('../../server/package.json', import.meta.url))('bitcoinjs-lib');
const digest = (algorithm, value) => createHash(algorithm).update(value).digest();
const sats = value => Math.round(value * 100000000);

// BOLT 3 offered HTLC on the sender's commitment. Its direct preimage branch
// takes a signature and 32 bytes. The optional one-block CSV is for anchors.
export function verifyIncomingWitness(witness, parentScript, paymentHash) {
  assert.match(paymentHash, /^[a-f0-9]{64}$/);
  assert.equal(witness.length, 3);
  const [signature, preimage, redeem] = witness;
  assert(script.isCanonicalScriptSignature(signature));
  assert.equal(preimage.length, 32);
  const hash = digest('sha256', preimage);
  assert.equal(hash.toString('hex'), paymentHash);
  assert.equal(parentScript.toString('hex'), '0020' + digest('sha256', redeem).toString('hex'));
  const words = script.decompile(redeem);
  assert(words && Buffer.isBuffer(words[2]) && words[2].length === 20);
  assert(Buffer.isBuffer(words[7]) && script.isCanonicalPubKey(words[7]));
  assert(Buffer.isBuffer(words[16]) && script.isCanonicalPubKey(words[16]));
  const anchors = words.length === 29;
  const expected = script.compile([op.OP_DUP, op.OP_HASH160, words[2], op.OP_EQUAL, op.OP_IF, op.OP_CHECKSIG,
    op.OP_ELSE, words[7], op.OP_SWAP, op.OP_SIZE, script.number.encode(32), op.OP_EQUAL, op.OP_NOTIF, op.OP_DROP,
    op.OP_2, op.OP_SWAP, words[16], op.OP_2, op.OP_CHECKMULTISIG, op.OP_ELSE, op.OP_HASH160, digest('ripemd160', hash),
    op.OP_EQUALVERIFY, op.OP_CHECKSIG, op.OP_ENDIF, ...(anchors ? [op.OP_1, op.OP_CHECKSEQUENCEVERIFY, op.OP_DROP] : []), op.OP_ENDIF]);
  assert.deepEqual(redeem, expected);
  return { anchors };
}

export async function qualifyIncomingClaim({ peer, senderId, receiverId, sender, receiver, gate, rpc, fixtureDirectory,
  preimage, paymentHash, funding, channel, expiry, stopWallet, until }) {
  assert(gate.verified && rpc('getblockhash', 0) === REGTEST_GENESIS);
  const watch = () => readPublicWatches(peer.child, receiverId, until);
  const current = async () => (await receiver('channels')).find(c => c.channelId === channel.channelId);
  const start = id => peer.api('/wallets/' + id + '/start', {});
  assert((await watch()).snapshot.outpoints.some(p => p.outpoint === funding));
  assert.equal((await current()).htlcCount, 1);
  await stopWallet(senderId);
  let settlement;
  try {
    const result = await receiver('invoice/settle-hold', { preimage: preimage.toString('hex') });
    assert.equal(result.paymentHash, paymentHash);
    settlement = 'accepted';
  } catch (error) {
    if (!/parked HTLC\(s\) remain for this payment hash/.test(error.message)) throw error;
    settlement = 'pending';
  } finally { preimage.fill(0); }
  // Reopen only the sender. It cannot accept the off-chain fulfill, and its
  // ordinary force-close path must reconstruct the current signed commitment.
  await stopWallet(receiverId);
  await start(senderId);
  await until('sender restored its held HTLC', () => sender('channels'), rows => rows.some(c => c.channelId === channel.channelId && c.htlcCount === 1));
  const close = await sender('channel/forceclose', { channelId: channel.channelId });
  assert.equal(close.forceClosed, true);
  const commitment = await until('sender commitment accepted by Core', () => rpc('getrawtransaction', close.commitmentTxid, true));
  assert.equal(commitment.vin.length, 1);
  assert.equal(`${commitment.vin[0].txid}:${commitment.vin[0].vout}`, funding);
  const outputs = commitment.vout.filter(o => sats(o.value) === 30000);
  assert.equal(outputs.length, 1);
  const previous = outputs[0];
  const commitmentHtlc = `${commitment.txid}:${previous.n}`;
  gate.mine(1);
  const heightOf = id => rpc('getblockheader', rpc('getrawtransaction', id, true).blockhash).height;
  const closeHeight = heightOf(commitment.txid);
  assert(closeHeight < expiry);
  await stopWallet(senderId);
  await start(receiverId);
  await until('reopened receiver classifies the current remote commitment', current,
    c => c?.closeStatus?.closer === 'remote' && c.closeStatus.closingTxid === commitment.txid && c.closeStatus.confirmationHeight === closeHeight);
  // The monitor schedules the anchor-format HTLC branch for parent height + 1.
  // Leave ample room before the independent absolute timeout can spend it.
  assert(rpc('getblockcount') + 2 < expiry);
  gate.mine(1);
  const claim = await until('receiver preimage spend independently accepted by Core', () => {
    const [spend] = rpc('gettxspendingprevout', [{ txid: commitment.txid, vout: previous.n }]);
    return spend.spendingtxid && rpc('getrawtransaction', spend.spendingtxid, true);
  });
  assert.equal(claim.vin.length, 1);
  const input = claim.vin[0];
  assert.equal(`${input.txid}:${input.vout}`, commitmentHtlc);
  const branch = verifyIncomingWitness(input.txinwitness.map(hex => Buffer.from(hex, 'hex')), Buffer.from(previous.scriptPubKey.hex, 'hex'), paymentHash);
  assert.equal(claim.vout.length, 1);
  const output = claim.vout[0];
  const receivedSats = sats(output.value);
  assert(receivedSats > 0 && receivedSats < 30000);
  gate.mine(1);
  const claimHeight = heightOf(claim.txid);
  assert(claimHeight > closeHeight && claimHeight < expiry);
  const claimOutput = `${claim.txid}:${output.n}`;
  await until('confirmed preimage claim credited to the receiver', async () => {
    await receiver('wallet/refresh', {});
    return (await receiver('utxos')).find(coin => coin.txid === claim.txid && coin.vout === output.n && coin.height === claimHeight &&
      coin.address === output.scriptPubKey.address && coin.valueSats === receivedSats);
  });
  assert.equal(rpc('gettxout', claim.txid, output.n).scriptPubKey.hex, output.scriptPubKey.hex);
  const live = await until('receiver watch contains the confirmed claim and its exact parent', watch, row =>
    [funding, commitmentHtlc, claimOutput].every(point => row.snapshot.outpoints.some(p => p.outpoint === point)));
  const result = { network: 'regtest', paymentHash, settlement, senderOfflineAtSettlement: true, receiverRestarted: true,
    fundingSats: channel.capacitySats, heldSats: 30000, receivedSats, closeHeight, claimHeight, expiry, anchors: branch.anchors };
  if (fixtureDirectory) await writeFundingFixture(fixtureDirectory, rpc, { live, liveRole: 'incoming-claim', currentFunding: funding, commitmentHtlc, claimOutput, incoming: result });
  return result;
}
