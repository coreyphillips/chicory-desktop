'use strict';

/**
 * Run with: npm test (from server/).
 *
 * The FFOR rules held without a daemon: what a settlement peer's block
 * accepts, the env it turns into, when a role edit needs a restart, which
 * siblings a receiver may pick, which epochs a fresh start reconciles, and
 * when a return counts as complete.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const ffor = require('./ffor');

const settler = (extra = {}) => ({
	id: 's1',
	name: 'Settler',
	network: 'regtest',
	nodeId: '02' + 'ab'.repeat(32),
	ffor: { settle: { enabled: true } },
	...extra
});

test('normalizeFfor fills defaults, validates the caps and clears an optional one on null', () => {
	assert.deepEqual(ffor.normalizeFfor(undefined), {
		concurrent: { enabled: true },
		funding: { enabled: false, maxChannels: 20, maxChannelsPerPeer: 5, maxChannelSats: 1000000, maxTotalSats: 5000000 },
		settle: { ...ffor.SETTLE_DEFAULTS },
		witness: { ...ffor.WITNESS_DEFAULTS },
		issuer: { ...ffor.ISSUER_DEFAULTS }
	});
	const on = ffor.normalizeFfor({ settle: { enabled: 1, maxBudgetMsat: '5000000', feePpm: 250 } });
	assert.deepEqual(on.settle, { enabled: true, acceptConcurrent: true, maxBudgetMsat: 5000000, maxEpochBlocks: null, feeBaseMsat: 0, feePpm: 250 });
	const kept = ffor.normalizeFfor({ settle: { maxBudgetMsat: null } }, on);
	assert.equal(kept.settle.enabled, true, 'an edit keeps what it does not name');
	assert.equal(kept.settle.maxBudgetMsat, null, 'null clears an optional cap');
	assert.equal(kept.settle.feePpm, 250);
	for (const bad of [
		{ settle: { feePpm: null } },
		{ settle: { feePpm: 'x' } },
		{ settle: { maxEpochBlocks: 100 } },
		{ settle: { feeBaseMsat: -1 } },
		{ settle: 'yes' },
		'yes'
	]) {
		assert.throws(() => ffor.normalizeFfor(bad), (err) => err.code === 'BAD_FFOR' && err.statusCode === 400);
	}
});

test('fforEnv is exactly the daemon switch plus the caps that are set, and nothing for everyone else', () => {
	assert.deepEqual(ffor.fforEnv({}), {});
	assert.deepEqual(ffor.fforEnv({ ffor: { settle: { enabled: false } } }), {});
	assert.deepEqual(ffor.fforEnv(settler({ onchainOnly: true })), {}, 'no listener, no settlement');
	assert.deepEqual(ffor.fforEnv(settler()), {
		BEIGNET_FFOR_SETTLE: 'true',
		BEIGNET_FFOR_FEE_BASE_MSAT: '0',
		BEIGNET_FFOR_FEE_PPM: '0'
	});
	const capped = ffor.fforEnv(settler({ ffor: { settle: { enabled: true, maxBudgetMsat: 10, maxEpochBlocks: 2016, feeBaseMsat: 1000, feePpm: 100 } } }));
	assert.equal(capped.BEIGNET_FFOR_MAX_BUDGET_MSAT, '10');
	assert.equal(capped.BEIGNET_FFOR_MAX_EPOCH_BLOCKS, '2016');
	assert.equal(capped.BEIGNET_FFOR_FEE_BASE_MSAT, '1000');
	assert.equal(capped.BEIGNET_FFOR_FEE_PPM, '100');
});

test('fforRoleChanged compares what a running daemon was spawned with against what the record wants', () => {
	const s = settler();
	assert.equal(ffor.fforRoleChanged({}, s), true, 'spawned plain, now a settler');
	assert.equal(ffor.fforRoleChanged(ffor.fforEnv(s), s), false);
	assert.equal(ffor.fforRoleChanged(ffor.fforEnv(s), { ffor: { settle: { enabled: false } } }), true, 'role dropped');
	assert.equal(ffor.fforRoleChanged(ffor.fforEnv(s), settler({ ffor: { settle: { enabled: true, feePpm: 5 } } })), true, 'a fee edit');
	assert.equal(ffor.fforRoleChanged({ BEIGNET_NETWORK: 'regtest' }, {}), false);
});

test('settlementCandidates are the opted-in siblings on the same network with a node id', () => {
	const self = { id: 'r1', network: 'regtest' };
	const records = [
		self,
		settler(),
		settler({ id: 's2', network: 'mainnet' }),
		settler({ id: 's3', nodeId: null }),
		settler({ id: 's4', ffor: { settle: { enabled: false } } }),
		settler({ id: 's5', onchainOnly: true })
	];
	assert.deepEqual(ffor.settlementCandidates(records, self, (rec) => rec.id === 's1'), [
		{ id: 's1', name: 'Settler', nodeId: '02' + 'ab'.repeat(32), running: true, settles: true, witnesses: false, issues: false }
	]);
});

test('returnJobs picks the receiver epochs a settlement peer may hold credits for', () => {
	const epochs = [
		{ channelId: 'aa', role: 'R', state: 'ACTIVE' },
		{ channelId: 'bb', role: 'R', state: 'DRAINING' },
		{ channelId: 'cc', role: 'R', state: 'CLOSED' },
		{ channelId: 'dd', role: 'R', state: 'NEGOTIATING' },
		{ channelId: 'ee', role: 'S', state: 'ACTIVE' }
	];
	assert.deepEqual(ffor.returnJobs(epochs), ['aa', 'bb']);
	assert.deepEqual(ffor.returnJobs(null), []);
});

test('describeReturn is complete only once the epoch closed with every slot accounted for', () => {
	const slots = (...states) => states.map((state, i) => ({ k: i + 1, state }));
	const closedRaw = { action: 'closed', preimagesKnown: [1], epoch: { state: 'CLOSED', slots: slots('settled', 'unsettled') } };
	const closed = ffor.describeReturn(closedRaw);
	assert.equal(closed.complete, false, 'a slot the wallet could be owed still reads unsettled');
	assert.equal(closed.credited, 1);
	assert.equal(closed.settled, 1);
	const doneRaw = { action: 'closed', preimagesKnown: [1, 2], epoch: { state: 'CLOSED', slots: slots('settled', 'settled') } };
	assert.equal(ffor.describeReturn(doneRaw).complete, true);
	const awayRaw = { action: 'nothing', preimagesKnown: [], epoch: { state: 'ACTIVE', slots: slots('exposed', 'unissued') } };
	assert.equal(ffor.describeReturn(awayRaw).complete, false, 'the peer was not reachable');
	assert.match(ffor.returnLogLine('abcd', awayRaw), /not reachable/);
	assert.match(ffor.returnLogLine('abcd', doneRaw), /closed, 2 of 2 slots settled, 2 preimages known/);
	assert.match(ffor.returnLogLine('abcd', null, new Error('boom')), /failed, boom/);
	assert.equal(ffor.describeReturn(null), null);
});

test('describeReturn credits through the settled bitmap when no witness returned a preimage', () => {
	const d = ffor.describeReturn({ action: 'closed', preimagesKnown: [], epoch: { state: 'CLOSED', slots: [{ k: 1, state: 'settled' }, { k: 2, state: 'unsettled' }] } });
	assert.equal(d.credited, 1);
	assert.equal(d.settled, 1);
});

test('returnJobs skips an epoch whose channel is closed on-chain', () => {
	const epochs = [{ channelId: 'aa', role: 'R', state: 'ACTIVE' }, { channelId: 'bb', role: 'R', state: 'ACTIVE' }];
	assert.deepEqual(ffor.returnJobs(epochs, [{ channelId: 'aa', state: 'FORCE_CLOSED' }, { channelId: 'bb', state: 'NORMAL' }]), ['bb']);
	assert.deepEqual(ffor.returnJobs(epochs), ['aa', 'bb'], 'no channel list, no exclusion');
});

test('returnOutcome reads the epoch and the channel, not the action alone', () => {
	const ep = (state) => ({ state, slots: [] });
	assert.equal(ffor.returnOutcome({ action: 'nothing', epoch: ep('CLOSED') }), 'closed');
	assert.equal(ffor.returnOutcome({ action: 'closed', epoch: ep('CLOSED') }), 'closed');
	assert.equal(ffor.returnOutcome({ action: 'nothing', epoch: ep('DRAINING') }), 'draining');
	assert.equal(ffor.returnOutcome({ action: 'closed', epoch: ep('DRAINING') }), 'draining');
	assert.equal(ffor.returnOutcome({ action: 'nothing', epoch: ep('ACTIVE'), channelState: 'FORCE_CLOSED' }), 'enforced');
	assert.equal(ffor.returnOutcome({ action: 'nothing', epoch: ep('ACTIVE'), channelState: 'AWAITING_REESTABLISH' }), 'unreachable');
	assert.equal(ffor.returnOutcome({ action: 'force-closed', epoch: ep('ACTIVE') }), 'force-closed');
	assert.equal(ffor.returnOutcome({ action: null, epoch: null, error: 'x' }), 'failed');
	const d = ffor.describeReturn({ action: 'nothing', preimagesKnown: [], epoch: { state: 'CLOSED', slots: [{ k: 1, state: 'settled' }] } });
	assert.equal(d.outcome, 'closed');
	assert.equal(d.complete, true);
});

test('the witness and issuer roles: defaults, the issuer needing the witness, the env each contributes', () => {
	const off = ffor.normalizeFfor(undefined);
	assert.deepEqual(off.witness, { enabled: false, maxMailboxes: null, maxBytes: null });
	assert.deepEqual(off.issuer, { enabled: false });
	assert.throws(() => ffor.normalizeFfor({ issuer: { enabled: true } }), (err) => err.code === 'BAD_FFOR' && /witness/.test(err.message));
	const both = ffor.normalizeFfor({ witness: { enabled: true, maxMailboxes: '8' }, issuer: { enabled: true } });
	assert.equal(both.witness.maxMailboxes, 8);
	assert.equal(both.issuer.enabled, true);
	assert.throws(() => ffor.normalizeFfor({ witness: { maxBytes: 10 } }), (err) => err.code === 'BAD_FFOR');
	const rec = { nodeId: '02' + 'ab'.repeat(32), ffor: both };
	assert.deepEqual(ffor.fforEnv(rec), { BEIGNET_FFOR_WITNESS: 'true', BEIGNET_FFOR_WITNESS_MAX_MAILBOXES: '8', BEIGNET_FFOR_ISSUER: 'true' });
	assert.equal(ffor.isWitness(rec), true);
	assert.equal(ffor.isIssuer(rec), true);
	assert.equal(ffor.isSettler(rec), false);
	assert.deepEqual(ffor.fforEnv({ ffor: { witness: { enabled: true }, issuer: { enabled: true }, settle: { enabled: true } } }).BEIGNET_FFOR_SETTLE, 'true');
	assert.deepEqual(ffor.fforEnv({ ffor: both, onchainOnly: true }), {});
	// Dropping the witness in an edit takes the issuer with it, or the daemon would refuse to start.
	assert.throws(() => ffor.normalizeFfor({ witness: { enabled: false } }, both), (err) => err.code === 'BAD_FFOR');
	assert.equal(ffor.fforRoleChanged(ffor.fforEnv(rec), { ...rec, ffor: { ...both, issuer: { enabled: false } } }), true);
});

test('candidates carry every role a sibling holds', () => {
	const self = { id: 'r1', network: 'regtest' };
	const w = { id: 'w1', name: 'Witness', network: 'regtest', nodeId: '02' + 'cd'.repeat(32), ffor: { witness: { enabled: true }, issuer: { enabled: true } } };
	const s = { id: 's1', name: 'Settler', network: 'regtest', nodeId: '02' + 'ef'.repeat(32), ffor: { settle: { enabled: true } } };
	assert.deepEqual(ffor.settlementCandidates([self, w, s], self), [
		{ id: 'w1', name: 'Witness', nodeId: w.nodeId, running: false, settles: false, witnesses: true, issues: true },
		{ id: 's1', name: 'Settler', nodeId: s.nodeId, running: false, settles: true, witnesses: false, issues: false }
	]);
});

test("a sibling settlement peer's book carries its own forwarding policy, raised to its floor", () => {
	const settler = { ffor: { settle: { enabled: true, feeBaseMsat: 0, feePpm: 50 } } };
	assert.deepEqual(ffor.settlerTerms({ feeBaseMsat: 1000, feeProportionalMillionths: 1 }, settler), { feeBaseMsat: 1000, feeProportionalMillionths: 50 });
	assert.equal(ffor.settlerTerms(null, settler), null);
	assert.deepEqual(ffor.settlerTerms({ feeBaseMsat: '2000', feeProportionalMillionths: 10 }, {}), { feeBaseMsat: 2000, feeProportionalMillionths: 10 });
});

test('automatic channel funding is explicit, bounded, and carried to the daemon', () => {
	const rec = {
		ffor: ffor.normalizeFfor({
			settle: { enabled: true },
			funding: { enabled: true, maxChannels: 2, maxChannelsPerPeer: 1, maxChannelSats: 80000, maxTotalSats: 160000 }
		})
	};
	assert.deepEqual(JSON.parse(ffor.fforEnv(rec).BEIGNET_FFOR_RECEIVE_FUNDING), rec.ffor.funding);
	assert.equal(ffor.fforEnv({ ffor: { settle: { enabled: true } } }).BEIGNET_FFOR_RECEIVE_FUNDING, undefined);
	assert.throws(() => ffor.normalizeFfor({ funding: { enabled: true } }), /Enable settlement/);
	for (const bad of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])
		assert.throws(() =>
			ffor.normalizeFfor({ settle: { enabled: true }, funding: { enabled: true, maxTotalSats: bad } })
		);
});


test('concurrent advertisement and settlement acceptance default on without enabling the settlement role', () => {
  const defaults = ffor.normalizeFfor();
  assert.equal(defaults.concurrent.enabled, true);
  assert.equal(defaults.settle.acceptConcurrent, true);
  assert.equal(defaults.settle.enabled, false);
  assert.deepEqual(ffor.fforEnv({ ffor: { concurrent: { enabled: false } } }), { BEIGNET_FFOR_CONCURRENT: 'false' });
  const declined = ffor.fforEnv({ ffor: { settle: { enabled: true, acceptConcurrent: false } } });
  assert.equal(declined.BEIGNET_FFOR_SETTLE_CONCURRENT, 'false');
  assert.throws(() => ffor.normalizeFfor({ settle: { acceptConcurrent: 'false' } }), { code: 'BAD_FFOR' });
});

test('concurrent receipt custody does not count as credit or release an unknown slot', () => {
  const result = { action: 'synced', preimagesKnown: [1, 2], epoch: { concurrent: true, concurrentVersion: 2, state: 'DRAINING', slots: [{ state: 'redeemed' }, { state: 'settled' }, { state: 'exposed' }] } };
  const view = ffor.describeReturn(result);
  assert.equal(view.credited, 1);
  assert.equal(view.unsettled, 2);
  assert.equal(view.complete, false);
  assert.throws(() => ffor.planSetup({ concurrent: true, concurrentVersion: 2, issuer: { walletId: 'issuer' } }, [], 'peer'), /issuer/i);
});
