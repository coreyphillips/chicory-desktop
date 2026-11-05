import assert from 'node:assert/strict';
import { createECDH } from 'node:crypto';
import { createRequire } from 'node:module';
import test from 'node:test';
import { reviewFunding } from './floresta-channel-lab.mjs';

const load = createRequire(new URL('../../server/package.json', import.meta.url));
const { networks, payments, Transaction } = load('bitcoinjs-lib');
const network = networks.regtest;
const pub = scalar => {
  const key = createECDH('secp256k1');
  key.setPrivateKey(Buffer.from(scalar.toString(16).padStart(64, '0'), 'hex'));
  return key.getPublicKey(undefined, 'compressed');
};
function fixture() {
  const a = pub(1), b = pub(2), fundingKey = pub(3), changeKey = pub(4);
  const from = payments.p2wpkh({ pubkey: fundingKey, network }), change = payments.p2wpkh({ pubkey: changeKey, network });
  const joint = payments.p2wsh({ network, redeem: payments.p2ms({ network, m: 2, pubkeys: [a, b].sort(Buffer.compare) }) });
  const deposit = new Transaction();
  deposit.addInput(Buffer.alloc(32, 5), 0); deposit.addOutput(from.output, 600000);
  const funding = new Transaction();
  funding.addInput(deposit.getHash(), 0); funding.addOutput(joint.output, 300000); funding.addOutput(change.output, 299575);
  funding.setWitness(0, [Buffer.from('300602010102010101', 'hex'), fundingKey]);
  const left = { temporary: '41'.repeat(32), local: a.toString('hex'), remote: b.toString('hex'), capacity: 300000 };
  const right = { ...left, local: left.remote, remote: left.local };
  return { funding, deposit, left, right, opener: { address: from.address, change: change.address } };
}
function review(f) {
  return reviewFunding({ ...f, proposal: { hex: f.funding.toHex(), txid: f.funding.getId(), vout: 0 } });
}
test('funding review binds the two negotiated keys, exact input, change and witness before the independent signature check', () => {
  assert.equal(review(fixture()).fee, 425);
  const mutations = [
    f => { f.right.remote = f.right.local; },
    f => { f.right.temporary = '42'.repeat(32); },
    f => { f.right.capacity++; },
    f => { f.funding.ins[0].index++; },
    f => { f.funding.ins[0].witness[0][8] = Transaction.SIGHASH_SINGLE; },
    f => { f.funding.ins[0].witness[1] = pub(5); },
    f => { f.funding.outs[0].value--; },
    f => { f.funding.outs[1].script = f.deposit.outs[0].script; },
    f => { f.funding.outs[1].value -= 4000; },
    f => { f.funding.addOutput(f.deposit.outs[0].script, 1); },
  ];
  for (const mutate of mutations) { const f = fixture(); mutate(f); assert.throws(() => review(f)); }
});
