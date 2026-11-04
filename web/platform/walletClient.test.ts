import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_PRIMARY_URI } from '@beignet/wallet-core';
import {
  createHostWalletClient,
  createSameOriginWalletFetch,
} from './walletClient.ts';

const NOW = 1_788_600_000_000;
const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
// Parser-only fixture; the fake daemon below supplies its decoded fields.
const INVOICE = 'lnbc100u1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq5px80g';
const HASH = 'ab'.repeat(32);
const record = {
  id: 'wallet-1', name: 'My wallet', network: 'mainnet', status: 'running',
  lfbw: {
    enabled: true, primaryUri: DEFAULT_PRIMARY_URI,
    primaryPubkey: DEFAULT_PRIMARY_URI.split('@')[0], setup: 'ready',
  },
};

function response(result: unknown, status = 200): Response {
  return new Response(JSON.stringify({ ok: status < 400, result }), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}

function fixture(
  handler: (path: string, init: RequestInit) => Response | Promise<Response>,
  walletId?: string,
) {
  const calls: { path: string; init: RequestInit }[] = [];
  const fetch: typeof globalThis.fetch = async (input, init = {}) => {
    const path = String(input);
    calls.push({ path, init });
    assert.match(path, /^\/(?:api|wallets)\//);
    assert.equal(init.credentials, 'same-origin');
    assert.equal(init.redirect, 'error');
    assert.equal(init.cache, 'no-store');
    assert.equal(new Headers(init.headers).has('Authorization'), false);
    assert.equal(JSON.stringify(init).includes('umbrel-session-cookie'), false);
    return handler(path, init);
  };
  return { client: createHostWalletClient({ walletId, fetch, now: () => NOW }), calls };
}

test('lists only Lightning-first wallets and retains shared selection validation', async () => {
  const { client, calls } = fixture(path => {
    assert.equal(path, '/api/wallets');
    return response([record, { ...record, id: 'ordinary', lfbw: { enabled: false } }]);
  });
  assert.deepEqual((await client.listWallets()).map(wallet => wallet.id), ['wallet-1']);
  client.selectWallet('wallet-1');
  assert.equal(client.connection.walletId, 'wallet-1');
  assert.throws(() => client.selectWallet('../other'), { code: 'INVALID_WALLET' });
  assert.equal(calls.length, 1);
});

test('new wallet creation remains on the create route and selects its record', async () => {
  const { client, calls } = fixture((path, init) => {
    assert.equal(path, '/api/wallets');
    assert.equal(init.method, 'POST');
    assert.equal(Object.hasOwn(JSON.parse(String(init.body)), 'mnemonic'), false);
    return response({ record, mnemonic: PHRASE });
  });
  const created = await client.createWallet({ name: 'My wallet' });
  assert.equal(created.mnemonic, PHRASE);
  assert.equal(client.connection.walletId, record.id);
  assert.equal(calls.length, 1);
});

test('restoring routes the normalized phrase to import once and never generates a wallet', async () => {
  const { client, calls } = fixture((path, init) => {
    assert.equal(path, '/api/wallets/import');
    assert.equal(init.method, 'POST');
    const body = JSON.parse(String(init.body));
    assert.equal(body.mnemonic, PHRASE);
    assert.equal(body.recoveryMode, 'peer-storage');
    assert.equal(body.lfbw.enabled, true);
    return response({ record });
  });
  const imported = await client.createWallet({ mnemonic: `  ${PHRASE.toUpperCase()}  ` });
  assert.equal(imported.id, record.id);
  assert.equal(Object.hasOwn(imported, 'mnemonic'), false);
  assert.equal(calls.length, 1);
});

test('malformed restore input is refused before any network request', async () => {
  const { client, calls } = fixture(() => { throw new Error('Unexpected request'); });
  await assert.rejects(client.createWallet({ mnemonic: 'too short' }), { code: 'INVALID_MNEMONIC' });
  assert.equal(calls.length, 0);
});

test('recovery phrase uses a manager POST with no caching and keeps epoch protection', async () => {
  let resolve: (value: Response) => void = () => {};
  const pending = new Promise<Response>(done => { resolve = done; });
  const { client, calls } = fixture(() => pending, record.id);
  const phrase = client.getRecoveryPhrase();
  assert.equal(calls[0].path, '/api/wallets/wallet-1/recovery-phrase');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.body, '{}');
  assert.ok(calls[0].init.signal instanceof AbortSignal);
  client.selectWallet('wallet-2');
  resolve(response({ mnemonic: PHRASE }));
  await assert.rejects(phrase, { code: 'WALLET_CHANGED' });
});

test('recovery phrase succeeds only through explicit retrieval', async () => {
  const { client, calls } = fixture(() => response({ mnemonic: PHRASE }), record.id);
  assert.equal(await client.getRecoveryPhrase(), PHRASE);
  assert.equal(calls.length, 1);
});

test('config, start and stop use the authenticated same-origin manager', async () => {
  const { client, calls } = fixture(path => response(path === '/api/config'
    ? { lfbwAvailable: true } : record), record.id);
  assert.equal((await client.getConfig()).lfbwAvailable, true);
  await client.startWallet();
  await client.stopWallet();
  assert.deepEqual(calls.map(call => [call.path, call.init.method]), [
    ['/api/config', 'GET'],
    ['/api/wallets/wallet-1/start', 'POST'],
    ['/api/wallets/wallet-1/stop', 'POST'],
  ]);
});

test('stop without a selected wallet never sends a request', async () => {
  const { client, calls } = fixture(() => response(null));
  await assert.rejects(client.stopWallet(), { code: 'NO_WALLET' });
  assert.equal(calls.length, 0);
});

test('Electrum settings PATCH only the selected wallet through the manager', async () => {
  const electrum = { host: 'electrum.local', port: 50001, tls: false };
  const { client, calls } = fixture((path, init) => {
    assert.equal(path, '/api/wallets/wallet-1');
    assert.equal(init.method, 'PATCH');
    assert.deepEqual(JSON.parse(String(init.body)), { electrum });
    return response(record);
  }, record.id);
  await client.updateWalletSettings({ electrum });
  assert.equal(calls.length, 1);
  assert.equal(client.connection.walletId, record.id);
});

test('settings without a wallet are refused, and a late PATCH cannot update another selection', async () => {
  const electrum = { host: 'electrum.local', port: 50001, tls: false };
  let resolve: (value: Response) => void = () => {};
  const { client, calls } = fixture(() => new Promise<Response>(done => { resolve = done; }));
  await assert.rejects(client.updateWalletSettings({ electrum }), { code: 'NO_WALLET' });
  assert.equal(calls.length, 0);
  client.selectWallet(record.id);
  const save = client.updateWalletSettings({ electrum });
  client.selectWallet('wallet-2');
  client.selectWallet(record.id);
  resolve(response(record));
  await assert.rejects(save, { code: 'WALLET_CHANGED' });
});

test('transport refuses foreign origins and non-API paths before fetch', async () => {
  let calls = 0;
  const transport = createSameOriginWalletFetch(async () => { calls++; return response(null); });
  for (const url of [
    'https://example.org/api/wallets',
    'http://127.0.0.1.evil.test/api/wallets',
    'http://user@127.0.0.1/api/wallets',
    'http://127.0.0.1/api/wallets#fragment',
    'http://127.0.0.1/other',
  ]) {
    await assert.rejects(transport(url), { code: 'INVALID_URL' });
  }
  assert.equal(calls, 0);
});

test('transport discards caller authorization and cannot weaken credential or redirect policy', async () => {
  let seen: RequestInit | undefined;
  const transport = createSameOriginWalletFetch(async (_input, init) => {
    seen = init; return response(null);
  });
  await transport('http://127.0.0.1/api/config', {
    headers: { Authorization: 'Bearer secret', 'X-Token': 'secret' },
    credentials: 'include', redirect: 'follow', cache: 'default',
  });
  assert.equal(new Headers(seen?.headers).has('Authorization'), false);
  assert.equal(new Headers(seen?.headers).has('X-Token'), false);
  assert.equal(seen?.credentials, 'same-origin');
  assert.equal(seen?.redirect, 'error');
  assert.equal(seen?.cache, 'no-store');
});

test('read failures retain network errors and state-changing failures stay uncertain', async () => {
  const { client } = fixture(() => { throw new TypeError('Connection lost'); }, record.id);
  await assert.rejects(client.listWallets(), { code: 'NETWORK_ERROR' });
  await assert.rejects(client.startWallet(), { code: 'RESULT_UNCERTAIN' });
  await assert.rejects(client.stopWallet(), { code: 'RESULT_UNCERTAIN' });
});

test('unknown payment outcomes preserve the consumed review and payment lock', async () => {
  let payments = 0;
  const { client } = fixture((path) => {
    if (path === '/api/wallets/wallet-1') return response(record);
    if (path.endsWith('/invoice/decode')) return response({
      paymentHash: HASH, amountSats: 10_000, description: 'Coffee',
      timestamp: NOW / 1000 - 60, expiry: 3600,
    });
    if (path.endsWith('/liquidity')) return response({ sendableSats: 100_000 });
    if (path.endsWith('/peers')) return response([{ pubkey: record.lfbw.primaryPubkey, connected: true }]);
    if (path.endsWith('/payment/estimate')) return response({ estimatedFeeSats: 7 });
    if (path.endsWith('/invoice/pay-safe')) { payments++; throw new TypeError('Connection lost'); }
    throw new Error(`Unexpected path ${path}`);
  }, record.id);
  const review = await client.prepareSend({ request: INVOICE });
  const result = await client.send(review);
  assert.equal(result.status, 'uncertain');
  await assert.rejects(client.send(review), { code: 'INVALID_REVIEW' });
  await assert.rejects(client.prepareSend({ request: INVOICE }), { code: 'ALREADY_SUBMITTED' });
  assert.equal(payments, 1);
});

test('explicit completed debit semantics project recipient amount while retaining the total debit', async () => {
  const rows = [
    { paymentHash: HASH, direction: 'OUTGOING', status: 'COMPLETED', amountSats: 12002, feeSats: 2, amountSemantics: 'total-debit-including-fee' },
    { paymentHash: 'zero-fee', direction: 'OUTGOING', status: 'COMPLETED', amountSats: 1000, feeSats: 0, amountSemantics: 'total-debit-including-fee' },
    // A real 1000-sat send paid 1001 msat. Both debit and fee round up,
    // preserving the exact integer recipient despite balance remainders.
    { paymentHash: 'fractional-fee', direction: 'OUTGOING', status: 'COMPLETED', amountSats: 1002, feeSats: 2, route: { totalFeeMsat: 1001 }, amountSemantics: 'total-debit-including-fee' },
  ];
  const transport = createSameOriginWalletFetch(async () => response(rows));
  const packet = await transport('http://127.0.0.1/wallets/wallet-1/api/payments').then(result => result.json());
  assert.equal(packet.result[0].amountSats, 12000);
  assert.equal(packet.result[0].debitSats, 12002);
  assert.equal(packet.result[0].feeSats, 2);
  assert.equal(packet.result[1].amountSats, 1000);
  assert.equal(packet.result[2].amountSats, 1000);
  assert.equal(packet.result[2].debitSats, 1002);
  assert.equal(packet.result[2].feeSats, 2);
});

test('unmarked, incoming, pending, failed, unknown fee and pay-all amounts are never guessed', async () => {
  const base = { direction: 'OUTGOING', status: 'COMPLETED', amountSats: 1002, feeSats: 2, amountSemantics: 'total-debit-including-fee' };
  const rows = [
    { ...base, amountSemantics: undefined }, { ...base, direction: 'INCOMING' },
    { ...base, status: 'PENDING' }, { ...base, status: 'FAILED' },
    { ...base, feeSats: undefined }, { ...base, payAll: { deliveredMsat: '1000000' } },
  ];
  const transport = createSameOriginWalletFetch(async () => response(rows));
  const packet = await transport('http://127.0.0.1/wallets/wallet-1/api/payments').then(result => result.json());
  assert.deepEqual(packet.result, JSON.parse(JSON.stringify(rows)));
});

test('contradictory explicit debit and fee fields fail rather than inventing a recipient amount', async () => {
  const transport = createSameOriginWalletFetch(async () => response([
    { direction: 'OUTGOING', status: 'COMPLETED', amountSats: 1, feeSats: 2, amountSemantics: 'total-debit-including-fee' },
  ]));
  await assert.rejects(transport('http://127.0.0.1/wallets/wallet-1/api/payments'), { code: 'INVALID_RESPONSE' });
});

test('a related wallet sends only the reference to the wallet whose phrase it reuses, for that one request', async () => {
  const { client, calls } = fixture(path => {
    if (path === '/api/wallets') return response({ record: { ...record, id: 'wallet-2', network: 'regtest' } });
    return response({});
  });
  const created = await client.createWallet({ name: 'Testnet twin', network: 'regtest', primaryUri: DEFAULT_PRIMARY_URI, seedFrom: { walletId: 'wallet-1', network: 'mainnet' } });
  assert.equal(created.id, 'wallet-2');
  assert.equal(created.mnemonic, undefined);
  const create = calls.find(call => call.path === '/api/wallets')!;
  const body = JSON.parse(String(create.init.body));
  assert.deepEqual(body.seedFrom, { walletId: 'wallet-1', network: 'mainnet' });
  assert.equal(body.mnemonic, undefined, 'no phrase travels');
  calls.length = 0;
  await client.createWallet({ name: 'Separate', network: 'regtest', primaryUri: DEFAULT_PRIMARY_URI });
  assert.equal(JSON.parse(String(calls.find(call => call.path === '/api/wallets')!.init.body)).seedFrom, undefined, 'the reference is not reused');
  await assert.rejects(client.createWallet({ name: 'Both', network: 'regtest', primaryUri: DEFAULT_PRIMARY_URI, mnemonic: PHRASE, seedFrom: { walletId: 'wallet-1', network: 'mainnet' } }),
    { code: 'INVALID_PARAMS' });
});
