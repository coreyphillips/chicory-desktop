import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import net from 'node:net';
import { createHostWalletClient } from '../../web/platform/walletClient.ts';

const GENESIS = '0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206';
const manager = process.env.REGTEST_MANAGER_URL ?? 'http://127.0.0.1:3920';
const bitcoin = process.env.REGTEST_BITCOIN_CONTAINER ?? 'chicory-browser-regtest-bitcoin-1';
const electrumPort = Number(process.env.REGTEST_ELECTRUM_PORT ?? '62401');
const output = process.env.REGTEST_STATE_FILE ?? '/private/tmp/chicory-browser-regtest-state.json';
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const evidence: Array<{ check: string; details?: unknown }> = [];
function pass(check: string, details?: unknown) {
  evidence.push({ check, ...(details === undefined ? {} : { details }) });
  console.log(`PASS ${check}${details === undefined ? '' : ` ${JSON.stringify(details)}`}`);
}
async function until<T>(label: string, read: () => Promise<T>, okay: (value: T) => boolean = Boolean, timeout = 120000): Promise<T> {
  const start = Date.now(); let last: unknown;
  while (Date.now() - start < timeout) {
    try { const value = await read(); if (okay(value)) return value; } catch (error) { last = error; }
    await wait(1000);
  }
  throw new Error(`Timed out waiting for ${label}${last instanceof Error ? `: ${last.message}` : ''}`);
}
async function request(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(new URL(path, manager), {
    method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const packet = await response.json();
  if (!response.ok || packet.ok === false) throw Object.assign(new Error(packet.error?.message ?? `HTTP ${response.status}`), { code: packet.error?.code });
  return packet.result;
}
const api = (path: string, body?: unknown, method?: string) => request(`/api${path}`, body, method);
const wallet = (id: string, path: string, body?: unknown) => request(`/wallets/${id}/api${path}`, body);
function rpc(method: string, ...params: unknown[]) {
  const text = execFileSync('docker', ['exec', bitcoin, 'bitcoin-cli', '-datadir=/data', '-regtest', '-rpcwallet=chicory-test', method, ...params.map(value => typeof value === 'string' ? value : JSON.stringify(value))], { encoding: 'utf8' }).trim();
  try { return JSON.parse(text); } catch { return text; }
}
async function electrum(method: string, params: unknown[]) {
  return new Promise<any>((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port: electrumPort });
    let text = '';
    socket.setTimeout(5000, () => socket.destroy(new Error('Electrum timed out')));
    socket.on('error', reject);
    socket.on('connect', () => socket.write(JSON.stringify({ id: 1, method, params }) + '\n'));
    socket.on('data', bytes => {
      text += bytes.toString();
      if (!text.includes('\n')) return;
      socket.end();
      const reply = JSON.parse(text.split('\n')[0]);
      if (reply.error) reject(new Error(reply.error.message)); else resolve(reply.result);
    });
  });
}
const client = (id?: string, now?: () => number) => createHostWalletClient({
  ...(id ? { walletId: id } : {}), now,
  fetch: (input, init) => fetch(new URL(String(input), manager), init),
});
async function fund(id: string, sats: number, confirmed = true) {
  const { address } = await wallet(id, '/address/new', {});
  const txid = rpc('sendtoaddress', address, sats / 1e8);
  if (confirmed) rpc('-generate', 1);
  await until('wallet observes funding', () => wallet(id, '/transactions'), rows => rows.some((item: any) => item.txid === txid && (!confirmed || item.confirmed)));
  return { address, txid };
}
async function healthy(id: string) {
  return until('wallet healthy', () => api(`/wallets/${id}`), record => record.healthy === true);
}
async function ready(id: string) {
  return until('wallet primary relationship ready', () => api(`/wallets/${id}`), record => record.healthy === true && record.lfbw?.setup === 'ready');
}

assert.equal(new URL(manager).hostname, '127.0.0.1', 'Only the isolated loopback manager is accepted.');
const config = await api('/config');
assert.equal(config.defaultNetwork, 'regtest');
assert.equal(rpc('getblockchaininfo').chain, 'regtest');
assert.equal(rpc('getblockhash', 0), GENESIS);
const header = await until('Electrum ready', () => electrum('blockchain.block.header', [0]));
const digest = createHash('sha256').update(createHash('sha256').update(Buffer.from(header, 'hex')).digest()).digest().reverse().toString('hex');
assert.equal(digest, GENESIS);
pass('Bitcoin, Electrum and manager verified as regtest');

const existing = await api('/wallets');
assert.ok(existing.every((record: any) => record.network === 'regtest'), 'Refuse a manager containing another network.');
const run = Date.now().toString(36);
const primary = (await api('/wallets', { name: `Chicory regtest primary ${run}`, network: 'regtest', networkMode: 'clearnet', publicHost: '127.0.0.1', announce: true })).record;
await healthy(primary.id);
await fund(primary.id, 5000000);
await until('primary funded', () => wallet(primary.id, '/balance'), balance => balance.onchain >= 5000000);
const sender = (await api('/wallets', { name: `Chicory regtest spending ${run}`, network: 'regtest', lfbw: { enabled: true, primaryWalletId: primary.id, initialChannelSats: 300000 } })).record;
await ready(sender.id);
await until('first home channel usable', () => wallet(sender.id, '/channels'), channels => channels.some((channel: any) => channel.state === 'NORMAL' && channel.htlcUsable));
// Confirm the primary's funding change before opening the next channel.
// A single primary UTXO cannot fund two concurrent v2 opens.
rpc('-generate', 1);
await until('primary funding change confirmed', () => wallet(primary.id, '/utxos'), utxos => utxos.some((utxo: any) => utxo.height > 0));
const receiver = (await api('/wallets', { name: `Chicory regtest receiving ${run}`, network: 'regtest', lfbw: { enabled: true, primaryWalletId: primary.id, initialChannelSats: 300000 } })).record;
await Promise.all([ready(sender.id), ready(receiver.id)]);
await until('both home channels usable', async () => Promise.all([wallet(sender.id, '/channels'), wallet(receiver.id, '/channels')]), lists => lists.every(channels => channels.some((channel: any) => channel.state === 'NORMAL' && channel.htlcUsable)));
const primaryRecord = await api(`/wallets/${primary.id}`);
const primaryUri = `${primaryRecord.nodeId}@127.0.0.1:${primaryRecord.listenPort}`;
const spending = client(sender.id);
const receiving = client(receiver.id);
assert.ok((await spending.listWallets()).some(record => record.id === sender.id));
pass('real manager wallets selected through UmbrelWalletClient');

const created = await client().createWallet({ name: `Chicory regtest browser-created ${run}`, network: 'regtest', primaryUri, electrum: { host: '127.0.0.1', port: electrumPort, tls: false } });
assert.equal(created.network, 'regtest');
await ready(created.id);
pass('shared browser client created and connected a real wallet', { walletId: created.id });

const deposit = await fund(sender.id, 400000, false);
const pending = await until('unconfirmed deposit snapshot', () => spending.snapshot(), snapshot => snapshot.balance.pendingSats >= 400000);
assert.ok(pending.activity.some(item => item.txid === deposit.txid && item.status === 'pending'));
pass('on-chain receive appears pending before confirmation', { txid: deposit.txid, pendingSats: pending.balance.pendingSats });
rpc('-generate', 1);
const funded = await until('confirmed funds channelized', () => spending.snapshot(), snapshot => snapshot.balance.availableSats >= 350000, 180000);
pass('confirmed on-chain receive becomes spendable', { availableSats: funded.balance.availableSats, totalSats: funded.balance.totalSats });

const bitcoinRequest = await receiving.receive(await receiving.quoteReceive({ amountSats: 5000, description: 'Chicory regtest Bitcoin receive' }));
assert.ok(bitcoinRequest.address);
const nextBitcoinRequest = await receiving.receive(await receiving.quoteReceive({ amountSats: 7000, description: 'Chicory regtest second Bitcoin receive' }));
assert.ok(nextBitcoinRequest.address);
assert.notEqual(bitcoinRequest.address, nextBitcoinRequest.address);
await receiving.stopWallet();
await receiving.startWallet();
await ready(receiver.id);
const bitcoinReceiveTxid = rpc('sendtoaddress', bitcoinRequest.address, 0.00005);
const bitcoinPending = await until('Bitcoin request observes its exact pending output', () => receiving.getReceiveStatus(bitcoinRequest), status => status.phase === 'pending' && status.receivedSats === 5000);
assert.equal(bitcoinPending.txid, bitcoinReceiveTxid);
const secondBitcoinTxid = rpc('sendtoaddress', nextBitcoinRequest.address, 0.00007);
const secondBitcoinPending = await until('second Bitcoin request remains watched after restart', () => receiving.getReceiveStatus(nextBitcoinRequest), status => status.phase === 'pending' && status.receivedSats === 7000);
assert.equal(secondBitcoinPending.txid, secondBitcoinTxid);
rpc('-generate', 1);
const bitcoinConfirmed = await until('Bitcoin request confirmed', () => receiving.getReceiveStatus(bitcoinRequest), status => status.phase === 'completed' && status.confirmedSats === 5000);
assert.equal(bitcoinConfirmed.method, 'bitcoin');
await until('second Bitcoin request confirmed independently', () => receiving.getReceiveStatus(nextBitcoinRequest), status => status.phase === 'completed' && status.confirmedSats === 7000);
pass('two unused receive requests have distinct watched addresses across wallet restart', { firstAddress: bitcoinRequest.address, secondAddress: nextBitcoinRequest.address });
pass('unified receive request tracks exact Bitcoin output before and after confirmation', { txid: bitcoinReceiveTxid, amountSats: bitcoinConfirmed.confirmedSats });

const quote = await receiving.quoteReceive({ amountSats: 12000, description: 'Chicory regtest Lightning receive' });
assert.equal(quote.netSats, 12000 - quote.feeSats);
const receive = await receiving.receive(quote);
assert.ok(receive.uri);
const beforeLightning = await spending.snapshot();
const review = await spending.prepareSend({ request: receive.bolt11 });
assert.equal(review.amountSats, 12000);
const paid = await spending.send(review);
assert.ok(['completed', 'pending'].includes(paid.status), `Lightning payment result ${paid.status}`);
const credited = await until('Lightning invoice settled', () => receiving.getReceiveStatus(receive), status => status.phase === 'completed');
const afterReceive = await receiving.snapshot();
assert.ok(afterReceive.activity.some(item => item.paymentHash === receive.paymentHash && item.amountSats === 12000 && item.status === 'completed'));
const afterLightning = await until('sent Lightning amount and actual fee recorded', () => spending.snapshot(), snapshot => snapshot.activity.some(item => item.paymentHash === receive.paymentHash && item.kind === 'sent' && item.status === 'completed' && item.feeKnown === true));
const sentLightning = afterLightning.activity.find(item => item.paymentHash === receive.paymentHash && item.kind === 'sent');
assert.ok(sentLightning);
assert.equal(sentLightning.amountSats, 12000);
assert.ok(sentLightning.feeSats <= review.feeSats);
// The daemon rounds a payment's fee up, while aggregate balance rounds the
// remaining millisatoshi total down. Fractional remainders can differ by 1 sat.
const balanceDebitSats = beforeLightning.balance.totalSats - afterLightning.balance.totalSats;
assert.ok([12000 + sentLightning.feeSats - 1, 12000 + sentLightning.feeSats].includes(balanceDebitSats));
pass('Lightning quote, review, payment and received activity settled', { paymentHash: receive.paymentHash, reviewedFeeSats: review.feeSats, actualFeeSats: sentLightning.feeSats, phase: credited.phase });
await assert.rejects(() => spending.send(review), error => ['REVIEW_USED', 'INVALID_REVIEW', 'PAYMENT_BUSY'].includes((error as any).code));
pass('a consumed payment review cannot send twice');

const tooMuch = await receiving.receive(await receiving.quoteReceive({ amountSats: 500000 }));
await assert.rejects(() => spending.prepareSend({ request: tooMuch.bolt11 }), error => (error as any).code === 'INSUFFICIENT_FUNDS');
pass('insufficient funds are refused before dispatch');

let clock = Date.now();
const expiring = client(sender.id, () => clock);
const expiryInvoice = await receiving.receive(await receiving.quoteReceive({ amountSats: 1000 }));
const expiringReview = await expiring.prepareSend({ request: expiryInvoice.bolt11 });
clock = expiringReview.expiresAt + 1;
await assert.rejects(() => expiring.send(expiringReview), error => /expir/i.test((error as Error).message));
pass('expired review is refused before dispatch');

const destination = rpc('getnewaddress');
const onchainReview = await spending.prepareSend({ request: destination, amountSats: 10000, feeRate: 2 });
const onchain = await spending.send(onchainReview);
assert.ok(['pending', 'completed'].includes(onchain.status));
const outgoing = await until('Bitcoin sees the reviewed payment output', async () => {
  for (const txid of rpc('getrawmempool')) {
    const tx = rpc('getrawtransaction', txid, true);
    if (tx.vout.some((item: any) => item.scriptPubKey.address === destination && Math.round(item.value * 1e8) === 10000))
      return { txid, actualFeeSats: Math.round(rpc('getmempoolentry', txid).fees.base * 1e8) };
  }
  return null;
}, Boolean, 180000);
assert.ok(outgoing);
assert.ok(outgoing.actualFeeSats <= onchainReview.feeSats, 'Broadcast fee must stay within the review.');
rpc('-generate', 1);
const sentSnapshot = await until('on-chain send confirmed', () => spending.snapshot(), snapshot => snapshot.activity.some(item => item.amountSats === 10000 && item.kind === 'sent' && item.status === 'completed'), 180000);
pass('on-chain review, broadcast and confirmed Activity settled', { ...outgoing, reviewedFeeSats: onchainReview.feeSats, totalSats: sentSnapshot.balance.totalSats });

await spending.stopWallet();
await spending.startWallet();
await ready(sender.id);
const restarted = await client(sender.id).snapshot();
const restoredLightning = restarted.activity.find(item => item.paymentHash === receive.paymentHash && item.kind === 'sent');
assert.ok(restoredLightning);
assert.equal(restoredLightning.id, sentLightning.id);
assert.equal(restoredLightning.amountSats, 12000);
assert.equal(restoredLightning.feeSats, sentLightning.feeSats);
assert.equal(restoredLightning.feeKnown, true);
assert.equal(restoredLightning.status, 'completed');
pass('wallet restart preserves completed Lightning payment');

const state = { manager, electrum: { host: '127.0.0.1', port: electrumPort, tls: false }, primaryUri, primaryId: primary.id, senderId: sender.id, receiverId: receiver.id, createdId: created.id, evidence };
await writeFile(output, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
console.log(`PASS verification state written to ${output}`);
