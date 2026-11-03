'use strict';

/**
 * Run with: npm test (from server/).
 *
 * The epoch setup with witnesses and an issuer (FFOR, spec sections 9.6
 * and 9.7), held against stubbed daemons: the book names the witnesses,
 * each witness is connected over loopback before it is provisioned, the
 * issuer's path template is built from its own channel policy toward the
 * settlement peer, the offer lands on the record, and the refusals a
 * wrong request earns before any daemon is touched.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { WalletManager } = require('./wallet-manager');
const ffor = require('./ffor');

const CH = 'ab'.repeat(32);
const S_NODE = '02' + '11'.repeat(32);
const W_NODE = '02' + '22'.repeat(32);
const R_NODE = '02' + '33'.repeat(32);

function managerWith() {
	const m = Object.create(WalletManager.prototype);
	const store = {
		r1: { id: 'r1', name: 'Receiver', network: 'regtest', port: 3901, nodeId: R_NODE, onchainOnly: false, recovery: { mode: 'off', guardians: [] } },
		s1: { id: 's1', name: 'Settler', network: 'regtest', port: 3902, nodeId: S_NODE, onchainOnly: false, ffor: { settle: { enabled: true } } },
		w1: { id: 'w1', name: 'Witness', network: 'regtest', port: 3903, nodeId: W_NODE, onchainOnly: false, ffor: { witness: { enabled: true }, issuer: { enabled: true } } }
	};
	m.registry = { get: (id) => store[id], list: () => Object.values(store), upsert: (r) => { store[r.id] = r; } };
	m.runtime = new Map();
	m.logs = [];
	m._log = (_id, line) => m.logs.push(line);
	m.fforSupported = true;
	for (const id of ['r1', 's1', 'w1']) {
		m.runtimeState(id).proc = {};
		m.runtimeState(id).healthy = true;
	}
	m.calls = [];
	const epoch = { channelId: CH, role: 'R', state: 'ACTIVE', epochId: 'e1', peerNodeId: S_NODE, witnessPeers: [W_NODE], slots: [{ k: 1, amountMsat: '50000000', state: 'unissued' }, { k: 2, amountMsat: '50000000', state: 'unissued' }], witnesses: [] };
	m.epoch = epoch;
	m._daemonCall = async (rec, method, path, body) => {
		m.calls.push([rec.id, method, path, body]);
		if (rec.id === 'r1') {
			if (path === '/channels') return [{ channelId: CH, peerPubkey: S_NODE, state: 'NORMAL' }];
			if (path === '/ffor/epoch/start') {
				epoch.witnessPeers = body.witnessPeers;
				return { ...epoch, state: 'NEGOTIATING' };
			}
			if (path.startsWith('/ffor/epoch?')) return epoch;
			if (path === '/peer/connect') return { connected: true };
			if (path === '/ffor/witness/provision') {
				epoch.witnesses.push({ witnessNodeId: body.witnessNodeId, mailboxId: 'mm'.repeat(32), retentionUntil: 5000, acknowledged: true });
				return { mailboxId: 'mm'.repeat(32), retentionUntil: 5000 };
			}
			if (path === '/ffor/issuer/offer') return { offerId: 'of'.repeat(32), encoded: 'lno1demo' };
			if (path === '/ffor/issuer/provision') return { mailboxId: 'mm'.repeat(32), blindedNodeIds: ['03' + '44'.repeat(32)] };
		}
		if (rec.id === 's1') {
			if (path.startsWith('/channel/policy?')) return { feeBaseMsat: 1000, feeProportionalMillionths: 1, cltvExpiryDelta: 40 };
		}
		if (rec.id === 'w1') {
			if (path === '/channels') return [{ channelId: 'cc'.repeat(32), peerPubkey: S_NODE, state: 'NORMAL', shortChannelId: '0000010000010000' }];
			if (path.startsWith('/channel/policy?')) return { feeBaseMsat: 1000, feeProportionalMillionths: 1, cltvExpiryDelta: 40, htlcMinimumMsat: '1000', htlcMaximumMsat: '1000000000' };
		}
		throw new Error(`unexpected ${rec.id} ${method} ${path}`);
	};
	m.listenPort = (rec) => rec.port + 6000;
	return { m, store };
}

const START = { voucherAmountsMsat: ['50000000', '50000000'], settlementDeadline: 1000, voucherExpiry: 2200, feeBaseMsat: 1000, feeProportionalMillionths: 100 };

test('a setup names the witness in the book, connects and provisions it, then provisions the issuer with its own hop', async () => {
	const { m, store } = managerWith();
	const setup = await m.fforSetupEpoch('r1', { channelId: CH, ...START, witnessWalletIds: ['w1'], issuer: { walletId: 'w1', description: 'Coffee' } });
	assert.equal(setup.step, 'done');
	assert.equal(setup.witnesses[0].step, 'acknowledged');
	assert.equal(setup.issuer.step, 'provisioned');
	const start = m.calls.find(([, , p]) => p === '/ffor/epoch/start')[3];
	assert.deepEqual(start.witnessPeers, [W_NODE]);
	assert.equal(start.settlementDeadline, 1000);
	assert.equal(start.feeBaseMsat, 1000, 'the terms are the settlement peer\'s own policy on the channel');
	assert.equal(start.feeProportionalMillionths, 1);
	const order = m.calls.filter(([id, , p]) => id === 'r1' && ['/peer/connect', '/ffor/witness/provision', '/ffor/issuer/offer', '/ffor/issuer/provision'].includes(p)).map(([, , p]) => p);
	assert.deepEqual(order, ['/peer/connect', '/ffor/witness/provision', '/ffor/issuer/offer', '/peer/connect', '/ffor/issuer/provision']);
	const connect = m.calls.find(([, , p]) => p === '/peer/connect')[3];
	assert.deepEqual(connect, { pubkey: W_NODE, host: '127.0.0.1', port: 9903 });
	const offer = m.calls.find(([, , p]) => p === '/ffor/issuer/offer')[3];
	assert.deepEqual(offer, { issuerNodeId: W_NODE, description: 'Coffee', amountMsat: '50000000' }, 'a uniform book names the amount');
	const provision = m.calls.find(([, , p]) => p === '/ffor/issuer/provision')[3];
	assert.equal(provision.offer, 'lno1demo');
	assert.deepEqual(provision.witnessHops, [
		{ nodeId: W_NODE, shortChannelId: '0000010000010000', feeBaseMsat: 1000, feeProportionalMillionths: 1, cltvExpiryDelta: 40, htlcMinimumMsat: '1000', htlcMaximumMsat: '1000000000' }
	]);
	assert.equal(store.r1.fforIssuance[CH].offerId, 'of'.repeat(32));
	assert.equal(store.r1.fforIssuance[CH].encoded, 'lno1demo');
	const rec = m.publicRecord('r1');
	assert.equal(rec.fforSetup.step, 'done');
	assert.equal(rec.fforIssuance[CH].issuerName, 'Witness');
	assert.match(m.logs.join('\n'), /witness "Witness" acknowledged/);
	assert.match(m.logs.join('\n'), /issuer "Witness" provisioned/);
});

test('the request is checked against the siblings before any daemon is touched', async () => {
	const { m } = managerWith();
	await assert.rejects(m.fforSetupEpoch('r1', { channelId: CH, ...START, witnessWalletIds: ['s1'] }), (err) => err.code === 'BAD_FFOR_SETUP' && /settlement peer/.test(err.message));
	await assert.rejects(m.fforSetupEpoch('r1', { channelId: CH, ...START, witnessWalletIds: ['nope'] }), (err) => err.code === 'BAD_FFOR_SETUP');
	await assert.rejects(m.fforSetupEpoch('r1', { channelId: CH, ...START, issuer: { walletId: 'w1', description: 'x' } }), (err) => /must be one of the witnesses/.test(err.message));
	await assert.rejects(m.fforSetupEpoch('r1', { channelId: CH, ...START, witnessWalletIds: ['w1'], issuer: { walletId: 'w1', description: ' ' } }), (err) => /description/.test(err.message));
	assert.equal(m.calls.filter(([, , p]) => p === '/ffor/epoch/start').length, 0);
	m.runtimeState('w1').healthy = false;
	await assert.rejects(m.fforSetupEpoch('r1', { channelId: CH, ...START, witnessWalletIds: ['w1'] }), (err) => /not running/.test(err.message));
});

test('provisioning on a running epoch refuses a witness the book did not name, and an aborted start is reported', async () => {
	const { m } = managerWith();
	m.epoch.witnessPeers = [];
	await assert.rejects(m.fforProvision('r1', { channelId: CH, witnessWalletIds: ['w1'] }), (err) => /was not named as a witness/.test(err.message));
	m.epoch.witnessPeers = [W_NODE];
	const setup = await m.fforProvision('r1', { channelId: CH, witnessWalletIds: ['w1'] });
	assert.equal(setup.witnesses[0].step, 'acknowledged');
	assert.equal(setup.issuer, null);
	// An issuer that has no channel to S is refused with the reason.
	const orig = m._daemonCall;
	m._daemonCall = async (rec, method, path, body) => (rec.id === 'w1' && path === '/channels' ? [] : orig(rec, method, path, body));
	await assert.rejects(m.fforProvision('r1', { channelId: CH, witnessWalletIds: ['w1'], issuer: { walletId: 'w1', description: 'x' } }), (err) => /no confirmed channel to the settlement peer/.test(err.message));
	assert.equal(m.publicRecord('r1').fforSetup.issuer.step, 'failed');
	// A start the peer aborts.
	m._daemonCall = async (rec, method, path, body) => {
		if (rec.id === 'r1' && path.startsWith('/ffor/epoch?')) return { ...m.epoch, state: 'ABORTED', abortReason: 2 };
		return orig(rec, method, path, body);
	};
	await assert.rejects(m.fforSetupEpoch('r1', { channelId: CH, ...START }), (err) => err.code === 'FFOR_SETUP_FAILED' && /reason 2/.test(err.message));
	assert.equal(m.publicRecord('r1').fforSetup.step, 'failed');
});

test('a return connects every sibling witness over loopback before asking the daemon to recover', async () => {
	const { m } = managerWith();
	m.epoch.witnesses = [{ witnessNodeId: W_NODE, mailboxId: 'mm'.repeat(32), retentionUntil: 5000, acknowledged: true }];
	const orig = m._daemonCall;
	m._daemonCall = async (rec, method, path, body) => {
		if (rec.id === 'r1' && path === '/ffor/recover') {
			m.calls.push([rec.id, method, path, body]);
			return { action: 'closed', preimagesKnown: [1], witnesses: [{ witnessNodeId: W_NODE, ok: true, error: null, credited: 1, records: [] }], epoch: { ...m.epoch, state: 'CLOSED' } };
		}
		return orig(rec, method, path, body);
	};
	m._waitEpochSettled = async () => ({ ...m.epoch, state: 'CLOSED' });
	const ret = await m.fforReturn('r1', { channelId: CH });
	const seq = m.calls.filter(([id, , p]) => id === 'r1' && ['/peer/connect', '/ffor/recover'].includes(p)).map(([, , p]) => p);
	assert.deepEqual(seq, ['/peer/connect', '/ffor/recover']);
	assert.equal(ret.witnesses[0].credited, 1);
	assert.equal(ffor.describeReturn(ret).outcome, 'closed');
});

test('an epoch closing retires its offer', () => {
	const { m, store } = managerWith();
	store.r1.fforIssuance = { [CH]: { epochId: 'e1', offerId: 'x' }, other: { epochId: 'e2' } };
	m._forgetIssuance('r1', CH);
	assert.deepEqual(Object.keys(store.r1.fforIssuance), ['other']);
});

test('manual setup requests version 2 without automatic quote headroom and preserves explicit baseline', async () => {
  const { m } = managerWith();
  m.concurrentOfflineReceiveSupported = true;
  m.epoch.concurrent = true;
  m.epoch.concurrentVersion = 2;
  await m.fforSetupEpoch('r1', { channelId: CH, ...START });
  const body = m.calls.find(([, , p]) => p === '/ffor/epoch/start')[3];
  assert.equal(body.concurrent, true);
  assert.equal(body.concurrentVersion, 2);
  assert.ok(!m.calls.some(([, , p]) => p.startsWith('/receive/quote')));
  await assert.rejects(m.fforSetupEpoch('r1', { channelId: CH, ...START, issuer: { walletId: 'w1' }, witnessWalletIds: ['w1'] }), /issuer provisioning/);
  const baseline = managerWith().m;
  baseline.concurrentOfflineReceiveSupported = true;
  await baseline.fforSetupEpoch('r1', { channelId: CH, ...START, concurrent: false });
  assert.equal(baseline.calls.find(([, , p]) => p === '/ffor/epoch/start')[3].concurrent, false);
});
