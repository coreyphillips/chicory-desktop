'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { createUpdateHold } = require('./update-hold');

function request(hold, method) {
	const res = Object.assign(new EventEmitter(), {
		statusCode: 200,
		body: null,
		status(code) { this.statusCode = code; return this; },
		json(body) { this.body = body; return this.end(); },
		end() { return this; }
	});
	let passed = false;
	hold.middleware({ method }, res, () => { passed = true; });
	return { res, passed };
}

test('an update hold waits for an in-flight payment to finish', async () => {
	const hold = createUpdateHold();
	const payment = request(hold, 'POST');
	assert.equal(payment.passed, true);
	let granted;
	const pending = hold.hold(1000).then((value) => { granted = value; });
	await new Promise(setImmediate);
	assert.equal(granted, undefined);
	const second = request(hold, 'POST');
	assert.equal(second.passed, false);
	assert.equal(second.res.statusCode, 503);
	assert.equal(second.res.body.error.code, 'UPDATE_PENDING');
	assert.equal(request(hold, 'GET').passed, true);
	payment.res.end();
	await pending;
	assert.equal(granted, true);
	assert.equal(hold.inFlight, 0);
});

test('a hold that outlasts its bound is refused and released', async () => {
	const hold = createUpdateHold();
	request(hold, 'POST');
	assert.equal(await hold.hold(10), false);
	assert.equal(hold.held, false);
	assert.equal(request(hold, 'DELETE').passed, true);
});

test('an idle manager grants a hold immediately and can release it', async () => {
	const hold = createUpdateHold();
	assert.equal(await hold.hold(), true);
	assert.equal(request(hold, 'PUT').passed, false);
	hold.release();
	assert.equal(request(hold, 'PUT').passed, true);
});

test('a client that disconnects does not end the wallet action it started', async (t) => {
	const hold = createUpdateHold();
	let started;
	const handlerStarted = new Promise((resolve) => { started = resolve; });
	const server = http.createServer((req, res) => hold.middleware(req, res, () => started(res)));
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	t.after(() => server.close());
	const client = http.request({ host: '127.0.0.1', port: server.address().port, method: 'POST', path: '/' });
	client.on('error', () => {});
	client.end();
	const res = await handlerStarted;
	const closed = new Promise((resolve) => res.once('close', resolve));
	client.destroy();
	await closed;
	assert.equal(hold.inFlight, 1);
	let granted;
	const pending = hold.hold(1000).then((value) => { granted = value; });
	await new Promise(setImmediate);
	assert.equal(granted, undefined);
	res.end('{}');
	await pending;
	assert.equal(granted, true);
	assert.equal(hold.inFlight, 0);
});
