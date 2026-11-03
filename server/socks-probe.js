'use strict';

const net = require('net');

/**
 * Minimal SOCKS5 CONNECT probe (no auth). Resolves true when the proxy
 * completes a CONNECT to host:port, false on any failure or timeout. Used to
 * verify the app's Tor can actually build circuits: its SOCKS port accepting
 * TCP says nothing about circuit health, and a circuit-dead Tor makes every
 * peer connection of a Tor-enabled wallet time out.
 */
function probeSocksConnect({ proxyHost, proxyPort, host, port, timeoutMs = 30000 }) {
	return new Promise((resolve) => {
		const socket = net.connect({ host: proxyHost, port: proxyPort });
		let stage = 'greeting';
		let done = false;
		// TCP does not preserve message boundaries: a reply can arrive split
		// across events. Accumulate and only evaluate once the two bytes we need
		// are present, so a segmented delivery is not misread as a failure.
		let buf = Buffer.alloc(0);
		const timer = setTimeout(() => finish(false), timeoutMs);
		function finish(ok) {
			if (done) return;
			done = true;
			clearTimeout(timer);
			socket.destroy();
			resolve(ok);
		}
		socket.on('error', () => finish(false));
		socket.on('connect', () => {
			socket.write(Buffer.from([0x05, 0x01, 0x00]));
		});
		socket.on('data', (chunk) => {
			buf = Buffer.concat([buf, chunk]);
			if (buf.length < 2) return;
			if (stage === 'greeting') {
				if (buf[0] !== 0x05 || buf[1] !== 0x00) return finish(false);
				stage = 'connect';
				buf = buf.subarray(2);
				const hostBuf = Buffer.from(host, 'utf8');
				socket.write(
					Buffer.concat([
						Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]),
						hostBuf,
						Buffer.from([(port >> 8) & 0xff, port & 0xff])
					])
				);
				if (buf.length < 2) return;
			}
			if (stage === 'connect') {
				finish(buf[0] === 0x05 && buf[1] === 0x00);
			}
		});
	});
}

module.exports = { probeSocksConnect };
