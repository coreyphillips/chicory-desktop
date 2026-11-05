import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import test from 'node:test';
import { penaltyWitness } from './floresta-breach-lab.mjs';

const { opcodes: op, script } = createRequire(new URL('../../server/package.json', import.meta.url))('bitcoinjs-lib');
const hash = (name, bytes) => createHash(name).update(bytes).digest();
const revocationKey = Buffer.from('02' + '12'.repeat(32), 'hex');
const delayedKey = Buffer.from('03' + '13'.repeat(32), 'hex');
const sig = '300602010102010101';
const delayed = script.compile([op.OP_IF, revocationKey, op.OP_ELSE, script.number.encode(144), op.OP_CHECKSEQUENCEVERIFY,
  op.OP_DROP, delayedKey, op.OP_ENDIF, op.OP_CHECKSIG]);
const htlc = script.compile([op.OP_DUP, op.OP_HASH160, hash('ripemd160', hash('sha256', revocationKey)), op.OP_EQUAL,
  op.OP_IF, op.OP_CHECKSIG, op.OP_ELSE, op.OP_DROP, op.OP_1, op.OP_ENDIF]);
const previous = redeem => ({ scriptPubKey: { hex: '0020' + hash('sha256', redeem).toString('hex') } });
const input = (redeem, selector) => ({ txinwitness: [sig, selector, redeem.toString('hex')] });

test('only an authenticated delayed or HTLC revocation branch proves a penalty spend', () => {
  const key = revocationKey.toString('hex');
  assert.deepEqual(penaltyWitness(input(delayed, '01'), previous(delayed)), { type: 'delayed', pubkey: key });
  assert.deepEqual(penaltyWitness(input(htlc, key), previous(htlc)), { type: 'htlc', pubkey: key });
  assert.equal(penaltyWitness(input(delayed, ''), previous(delayed)), null);
  assert.equal(penaltyWitness(input(delayed, '01'), previous(htlc)), null);
  assert.equal(penaltyWitness(input(htlc, delayedKey.toString('hex')), previous(htlc)), null);
  assert.equal(penaltyWitness(input(htlc, '00'.repeat(32)), previous(htlc)), null);
  assert.equal(penaltyWitness({ txinwitness: ['00', key, htlc.toString('hex')] }, previous(htlc)), null);
});
