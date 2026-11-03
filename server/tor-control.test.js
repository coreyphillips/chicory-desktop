'use strict';

/**
 * Run with: npm test (from server/).
 *
 * TorControl reports when the app's Tor first uploads the onion's descriptor,
 * which is what tells the manager that a failing self-probe means a broken Tor
 * rather than one still starting up. These run it against a stand-in control
 * port that answers the way Tor 0.4.9 does, events included.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { TorControl, pickLocalIp } = require('./tor-control');

const SERVICE_ID = 'qoudavrfwh6xegjdkblbmptw7af5ucwn4tmlfyoombyygnypxqkvtbad';
const OTHER_ID = 'pg6mmjiyjmcrsslvykfwnntlaru7p5svn6y2ymmju6nubxndf4pscryd';
const HSDIR = '$637DEB41569E4B4C9D6A64D1A84D9C9D3E6A1C2B~relay';
// TorControl maps the onion to this machine's first non-loopback IPv4 address
// and gives up without one, as in a sandbox with no network.
const skip = pickLocalIp() ? false : 'no non-loopback IPv4 address to map the onion to';

async function waitFor(check, what, ms = 3000) {
	const deadline = Date.now() + ms;
	while (!check()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 10));
	}
}

// A control port that authenticates anything and answers ADD_ONION with
// `addOnion` (a function of the command, returning the raw reply).
async function fakeTor(t, { setEvents = '250 OK', addOnion } = {}) {
	const tor = { client: null, commands: [] };
	const server = net.createServer((socket) => {
		tor.client = socket;
		let buf = '';
		socket.on('data', (chunk) => {
			buf += chunk.toString('utf8');
			let i;
			while ((i = buf.indexOf('\r\n')) >= 0) {
				const line = buf.slice(0, i);
				buf = buf.slice(i + 2);
				tor.commands.push(line);
				if (line.startsWith('AUTHENTICATE')) socket.write('250 OK\r\n');
				else if (line.startsWith('SETEVENTS')) socket.write(`${setEvents}\r\n`);
				else if (line.startsWith('ADD_ONION')) socket.write(addOnion(line));
				else if (line.startsWith('DEL_ONION')) socket.write('250 OK\r\n');
			}
		});
		socket.on('error', () => {});
	});
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	tor.port = server.address().port;
	tor.event = (text) => tor.client.write(text);
	t.after(() => server.close());
	return tor;
}

function control(t, tor, keyFile) {
	const logs = [];
	const tc = new TorControl({
		host: '127.0.0.1',
		port: tor.port,
		password: 'pw',
		keyFile,
		ports: [9101],
		log: (m) => logs.push(m)
	});
	t.after(() => tc.stop());
	return { tc, logs };
}

function keyPath(t) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tor-control-'));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	return path.join(dir, 'onion_key');
}

const created = () =>
	// An event ahead of the reply. TorControl subscribes only after ADD_ONION,
	// so Tor should not send one here, but a reader that took the first "NNN "
	// line for the reply would fail on it.
	`650 HS_DESC REQUESTED ${OTHER_ID} NO_AUTH ${HSDIR} abc\r\n` +
	`250-ServiceID=${SERVICE_ID}\r\n250-PrivateKey=ED25519-V3:secret\r\n250 OK\r\n`;

test('a fresh onion counts as uploaded only once Tor reports its own upload', { skip }, async (t) => {
	const tor = await fakeTor(t, { addOnion: created });
	const { tc, logs } = control(t, tor, keyPath(t));

	assert.equal(await tc.start(), `${SERVICE_ID}.onion`);
	assert.ok(tor.commands.includes('SETEVENTS HS_DESC'));
	assert.ok(tc.publishedAt);
	assert.equal(tc.uploadedAt, null);

	// The upload starting, someone else's descriptor, and a lookup are all
	// beside the point.
	tor.event(`650 HS_DESC UPLOAD ${SERVICE_ID} UNKNOWN ${HSDIR} abc\r\n`);
	tor.event(`650 HS_DESC UPLOADED ${OTHER_ID} UNKNOWN ${HSDIR}\r\n`);
	tor.event(`650 HS_DESC RECEIVED ${SERVICE_ID} NO_AUTH ${HSDIR} abc\r\n`);
	await new Promise((r) => setTimeout(r, 50));
	assert.equal(tc.uploadedAt, null);

	// Split across two reads, as TCP is free to deliver it.
	tor.event(`650 HS_DESC UPLOADED ${SERVICE_ID.slice(0, 20)}`);
	tor.event(`${SERVICE_ID.slice(20)} UNKNOWN ${HSDIR}\r\n`);
	await waitFor(() => tc.uploadedAt, 'the upload to be recorded');
	assert.ok(tc.uploadedAt >= tc.publishedAt);
	assert.ok(logs.some((l) => /onion descriptor uploaded/.test(l)));
});

test('an onion this Tor already had counts as uploaded at once', { skip }, async (t) => {
	const keyFile = keyPath(t);
	fs.writeFileSync(
		keyFile,
		JSON.stringify({ key: 'ED25519-V3:secret', address: `${SERVICE_ID}.onion`, target: pickLocalIp() })
	);
	const tor = await fakeTor(t, { addOnion: () => '550 Onion address collision\r\n' });
	const { tc } = control(t, tor, keyFile);

	assert.equal(await tc.start(), `${SERVICE_ID}.onion`);
	assert.ok(tc.publishedAt);
	assert.ok(tc.uploadedAt);
});

test('a Tor that refuses descriptor events still publishes, and is probed from the start', { skip }, async (t) => {
	const tor = await fakeTor(t, { setEvents: '552 Unrecognized event "HS_DESC"', addOnion: created });
	const { tc, logs } = control(t, tor, keyPath(t));

	assert.equal(await tc.start(), `${SERVICE_ID}.onion`);
	assert.equal(tc.uploadedAt, tc.publishedAt);
	assert.ok(logs.some((l) => /no descriptor events/.test(l)));
});
