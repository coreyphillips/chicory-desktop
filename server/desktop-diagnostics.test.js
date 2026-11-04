'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { snapshot, installDesktopDiagnostics, threadCount } = require('./desktop-diagnostics');

function manager() {
	const records = [{ id: 'w1', name: 'Savings' }, { id: 'w2', name: 'Spending' }, { id: 'w3', name: 'Idle' }];
	return {
		engineVersion: '0.9.4',
		registry: { list: () => records },
		runtime: new Map([
			['w1', { status: 'running', restartCount: 0, lastExit: null, lastStartError: null }],
			['w2', { status: 'restarting', restartCount: 2,
				lastExit: { code: null, signal: 'SIGSEGV', at: '2026-01-01T00:00:02.000Z', expected: false },
				lastStartError: { message: 'START_FAILED', at: '2026-01-01T00:00:01.000Z' } }]
		]),
		health: () => ({ status: 'ok' })
	};
}

test('reports a crashed engine by counts and exit code, without wallet names or ids', () => {
	const result = snapshot(manager(), { clock: () => 5, threads: () => undefined });
	assert.equal(result.at, 5);
	assert.equal(result.engineVersion, '0.9.4');
	assert.equal(result.vaultFormat, 1);
	assert.deepEqual(
		{ total: result.wallets.total, running: result.wallets.running, restarting: result.wallets.restarting, stopped: result.wallets.stopped },
		{ total: 3, running: 1, restarting: 1, stopped: 1 }
	);
	assert.equal(result.wallets.restarts, 2);
	assert.deepEqual(result.wallets.lastExit, { code: null, signal: 'SIGSEGV', at: '2026-01-01T00:00:02.000Z', expected: false });
	assert.equal(result.resources.threads, 'unsupported');
	assert.ok(Number.isInteger(result.resources.rssKb));
	const text = JSON.stringify(result);
	for (const secret of ['Savings', 'Spending', 'w1', 'w2']) assert.equal(text.includes(secret), false);
});

test('reads the thread count only where the platform exposes it', () => {
	assert.equal(threadCount('darwin'), undefined);
	assert.equal(threadCount('linux', () => 'Name:\tnode\nThreads:\t17\n'), 17);
	assert.equal(threadCount('linux', () => { throw new Error('denied'); }), null);
});

test('answers diagnostics requests over the desktop channel', () => {
	const channel = Object.assign(new EventEmitter(), { connected: true, sent: [] });
	channel.send = (message, callback) => { channel.sent.push(message); callback(); };
	const remove = installDesktopDiagnostics(manager(), channel, { clock: () => 1, threads: () => 4 });
	channel.emit('message', { type: 'diagnostics:request', requestId: 'r1' });
	channel.emit('message', { type: 'diagnostics:request', requestId: 'x'.repeat(65) });
	channel.emit('message', { type: 'tor:status' });
	assert.equal(channel.sent.length, 1);
	assert.equal(channel.sent[0].type, 'diagnostics:result');
	assert.equal(channel.sent[0].requestId, 'r1');
	assert.equal(channel.sent[0].result.resources.threads, 4);
	remove();
	channel.emit('message', { type: 'diagnostics:request', requestId: 'r2' });
	assert.equal(channel.sent.length, 1);
});
