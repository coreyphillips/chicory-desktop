'use strict';

const fs = require('./vault-files').fs;
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { address: bitcoinAddress, networks, Transaction } = require('bitcoinjs-lib');
const { electrumRequests } = require('./electrum-probe');

const MAX_SATS = 2100000000000000;
const clone = value => JSON.parse(JSON.stringify(value));
function refuse(code, message, statusCode = 400) {
  throw Object.assign(new Error(message), { code, statusCode });
}
function amount(value, positive = false) {
  if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0) || value > MAX_SATS)
    refuse('INVALID_PARAMS', 'Enter a valid amount in satoshis.');
  return value;
}
function scriptFor(address, network) {
  try {
    const chain = network === 'mainnet' ? networks.bitcoin : network === 'regtest' ? networks.regtest : network === 'testnet' ? networks.testnet : null;
    if (!chain || typeof address !== 'string' || address.length > 128) throw new Error();
    return bitcoinAddress.toOutputScript(address, chain);
  } catch { refuse('INVALID_ADDRESS', 'Enter a Bitcoin address on this wallet\'s network.'); }
}
function atomicSave(file, value, { platform = process.platform } = {}) {
  const vault = require('./vault-files');
  if (vault.protects(file)) return vault.atomicWriteFileSync(file, JSON.stringify(value));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  const fd = fs.openSync(temporary, 'w', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(temporary, file);
  // Node cannot flush directory handles on Windows. Flush the replacement
  // file at its destination there; POSIX also commits the directory rename.
  const committed = fs.openSync(platform === 'win32' ? file : path.dirname(file), platform === 'win32' ? 'r+' : 'r');
  try { fs.fsyncSync(committed); } finally { fs.closeSync(committed); }
}

/** Public request links and splice identities live beside their wallet data. */
class BrowserWallet {
  constructor({ record, file, call, query, save = atomicSave }) {
    this.record = record; this.file = file; this.call = call; this.query = query; this.save = save;
    this.queue = Promise.resolve();
  }
  load() {
    if (this.state) return this.state;
    try {
      const value = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (value.version !== 1 || value.walletId !== this.record.id || value.network !== this.record.network ||
          !Array.isArray(value.requests) || value.requests.length > 5000 || !Array.isArray(value.addresses) ||
          value.addresses.length > 10000 || !Array.isArray(value.activity) || value.activity.length > 5000)
        throw new Error();
      for (const address of value.addresses) scriptFor(address, this.record.network);
      for (const row of value.requests) {
        if (!row || typeof row.id !== 'string' || typeof row.paymentHash !== 'string' || !/^[a-f0-9]{64}$/.test(row.paymentHash)) throw new Error();
      }
      for (const row of value.activity) {
        if (!row || typeof row.requestId !== 'string' || !['pending', 'uncertain', 'failed', 'completed'].includes(row.status) ||
            !Number.isSafeInteger(row.amountSats) || row.amountSats <= 0 || typeof row.address !== 'string') throw new Error();
      }
      this.state = value;
    } catch (error) {
      if (error.code !== 'ENOENT') refuse('WALLET_METADATA_UNAVAILABLE', 'Saved payment metadata is unreadable. Restore it before creating new requests or payments.', 503);
      this.state = { version: 1, walletId: this.record.id, network: this.record.network, addresses: [], requests: [], activity: [] };
    }
    return this.state;
  }
  commit(next) {
    if (JSON.stringify(next).length > 16 * 1024 * 1024) refuse('WALLET_METADATA_FULL', 'The saved payment history is full.', 503);
    this.save(this.file, next);
    this.state = next;
  }
  serial(operation) {
    const pending = this.queue.then(operation);
    this.queue = pending.catch(() => {});
    return pending;
  }
  requests() {
    const state = this.load();
    return state.requests.map(row => ({ ...clone(row), bitcoinTracking: row.address == null ? 'lightning-only' : state.requests.filter(other => other.address === row.address).length > 1 ? 'ambiguous' : 'unique' }));
  }
  allocate(body) {
    return this.serial(async () => {
      const state = this.load();
      if (state.addresses.length >= 10000) refuse('RECEIVE_ADDRESS_LIMIT', 'The receive address history is full.', 409);
      const result = await this.call('POST', '/address/new', { ...(body ?? {}), fresh: true });
      if (result?.fresh !== true) refuse('FRESH_ADDRESS_UNAVAILABLE', 'This host needs the fresh receive address update before creating payment requests.', 503);
      scriptFor(result?.address, this.record.network);
      if (state.addresses.includes(result.address)) refuse('RECEIVE_ADDRESS_LIMIT', 'The wallet could not allocate a fresh receive address.', 409);
      this.commit({ ...state, addresses: [...state.addresses, result.address] });
      return result;
    });
  }
  register(input) {
    return this.serial(async () => {
      const state = this.load();
      if (!input || input.demo || typeof input.id !== 'string' || !/^[A-Za-z0-9:_-]{1,160}$/.test(input.id) ||
          typeof input.uri !== 'string' || input.uri.length > 16384 || /[\s\u0000-\u001f]/.test(input.uri) ||
          typeof input.bolt11 !== 'string' || input.bolt11.length > 12000 ||
          typeof input.paymentHash !== 'string' || !/^[a-f0-9]{64}$/.test(input.paymentHash) ||
          typeof input.description !== 'string' || input.description.length > 256 ||
          !Array.isArray(input.warnings) || input.warnings.length > 20 || input.warnings.some(warning => typeof warning !== 'string' || warning.length > 1000))
        refuse('INVALID_RECEIVE_REQUEST', 'This is not a valid original payment request.');
      const requestedAmount = input.amountSats == null ? null : amount(input.amountSats, true);
      const feeSats = amount(input.feeSats);
      const [invoice, decoded] = await Promise.all([
        this.call('GET', `/invoice?paymentHash=${input.paymentHash}`),
        this.call('POST', '/invoice/decode', { bolt11: input.bolt11 }),
      ]);
      if (invoice?.bolt11?.toLowerCase() !== input.bolt11.toLowerCase() || invoice.paymentHash !== input.paymentHash ||
          decoded.paymentHash !== input.paymentHash || (decoded.amountSats || null) !== requestedAmount)
        refuse('RECEIVE_REQUEST_NOT_OWNED', 'This invoice does not belong to this wallet.');
      // The engine records an offline request in its offline receive journal,
      // not on the invoice, so a request the client calls offline is confirmed
      // there. Without this the flag was dropped and later reads treated the
      // request as an ordinary one.
      let offline = invoice.offlineReceive === true;
      if (!offline && input.offlineReceive === true) {
        const status = await this.call('GET', '/receive/status').catch(() => null);
        offline = Array.isArray(status?.requests) &&
          status.requests.some(job => job?.invoice?.paymentHash === input.paymentHash);
        if (!offline) refuse('INVALID_RECEIVE_REQUEST', 'This is not one of this wallet\'s offline payment requests.');
      }
      const expiresAt = (Number(decoded.timestamp) + Number(decoded.expiry ?? 3600)) * 1000;
      if (!Number.isSafeInteger(expiresAt) || !Number.isSafeInteger(input.expiresAt) || input.expiresAt <= 0 || input.expiresAt > expiresAt)
        refuse('INVALID_RECEIVE_REQUEST', 'The payment request expiry does not match its invoice.');
      const address = input.address ?? null;
      if (address === null) {
        if (input.uri.replace(/^lightning:/i, '').toLowerCase() !== input.bolt11.toLowerCase()) refuse('INVALID_RECEIVE_REQUEST', 'The request does not match its invoice.');
      } else {
        scriptFor(address, this.record.network);
        if (!state.addresses.includes(address)) refuse('RECEIVE_ADDRESS_NOT_OWNED', 'This Bitcoin address was not issued for this wallet.');
        if (!input.uri.startsWith(`bitcoin:${address}?`) || input.uri.includes('#')) refuse('INVALID_RECEIVE_REQUEST', 'The request does not match its Bitcoin address.');
        const query = new URLSearchParams(input.uri.slice(input.uri.indexOf('?') + 1));
        const seen = new Set();
        for (const [key] of query) {
          if (seen.has(key) || !['amount', 'message', 'label', 'lightning', 'bgnq'].includes(key)) refuse('INVALID_RECEIVE_REQUEST', 'The request has ambiguous fields.');
          seen.add(key);
        }
        if (query.get('lightning')?.toLowerCase() !== input.bolt11.toLowerCase()) refuse('INVALID_RECEIVE_REQUEST', 'The request has another Lightning invoice.');
        const btc = query.get('amount');
        let uriAmount = null;
        if (btc !== null) {
          if (!/^(0|[1-9][0-9]*)(\.[0-9]{1,8})?$/.test(btc)) refuse('INVALID_RECEIVE_REQUEST', 'The request amount is invalid.');
          const [whole, fraction = ''] = btc.split('.');
          uriAmount = BigInt(whole) * 100000000n + BigInt(fraction.padEnd(8, '0'));
        }
        if (uriAmount !== (requestedAmount === null ? null : BigInt(requestedAmount))) refuse('INVALID_RECEIVE_REQUEST', 'The request amount differs from the invoice.');
      }
      const request = {
        id: input.id, uri: input.uri, address, bolt11: input.bolt11, paymentHash: input.paymentHash,
        amountSats: requestedAmount, description: input.description, feeSats, expiresAt: input.expiresAt,
        warnings: [...input.warnings], demo: false, createdAt: Number(decoded.timestamp) * 1000,
        ...(offline ? { offlineReceive: true } : {}),
      };
      const previous = state.requests.find(row => row.paymentHash === request.paymentHash || row.id === request.id);
      if (previous) {
        if (JSON.stringify(previous) !== JSON.stringify(request)) refuse('RECEIVE_REQUEST_CONFLICT', 'This invoice or request ID is already linked to different payment details.', 409);
        return this.requests().find(row => row.id === previous.id);
      }
      if (address !== null) {
        if (state.requests.some(row => row.address === address))
          refuse('RECEIVE_ADDRESS_REUSED', 'This address already belongs to another request. Create a fresh request.', 409);
        const script = scriptFor(address, this.record.network);
        const hash = crypto.createHash('sha256').update(script).digest().reverse().toString('hex');
        const history = await this.query('blockchain.scripthash.get_history', [hash]);
        if (!Array.isArray(history)) refuse('RECEIVE_LOOKUP_UNAVAILABLE', 'The receive address could not be checked.', 503);
        if (history.length) refuse('RECEIVE_ADDRESS_USED', 'This address already has payments. Create a fresh request.', 409);
      }
      if (state.requests.length >= 5000) refuse('WALLET_METADATA_FULL', 'The saved request history is full.', 503);
      this.commit({ ...state, requests: [...state.requests, request] });
      return this.requests().find(row => row.id === request.id);
    });
  }
  async receipts(address) {
    const script = scriptFor(address, this.record.network);
    if (!this.load().addresses.includes(address)) refuse('RECEIVE_ADDRESS_NOT_OWNED', 'This address was not issued for this wallet.');
    const scriptHash = crypto.createHash('sha256').update(script).digest().reverse().toString('hex');
    const history = await this.query('blockchain.scripthash.get_history', [scriptHash]);
    if (!Array.isArray(history) || history.length > 64) refuse('RECEIVE_LOOKUP_UNAVAILABLE', 'Bitcoin receipt details are unavailable.', 503);
    const transactions = [];
    const seen = new Set();
    for (const row of history) {
      if (!row || !/^[a-f0-9]{64}$/.test(row.tx_hash) || !Number.isSafeInteger(row.height) || row.height < -1 || seen.has(row.tx_hash)) refuse('RECEIVE_LOOKUP_UNAVAILABLE', 'Bitcoin receipt details are inconsistent.', 503);
      seen.add(row.tx_hash);
      const tx = Transaction.fromHex(await this.query('blockchain.transaction.get', [row.tx_hash, false]));
      if (tx.getId() !== row.tx_hash) refuse('RECEIVE_LOOKUP_UNAVAILABLE', 'The Bitcoin transaction could not be verified.', 503);
      const amountSats = tx.outs.filter(output => output.script.equals(script)).reduce((sum, output) => amount(sum + amount(output.value)), 0);
      if (amountSats) transactions.push({ txid: row.tx_hash, amountSats, confirmed: row.height > 0 });
    }
    return { address, transactions };
  }
  submitSplice(body) {
    return this.serial(async () => {
      if (!body || !/^[A-Za-z0-9_-]{8,128}$/.test(body.requestId ?? '') || !/^[a-f0-9]{64}$/.test(body.channelId ?? '')) refuse('REQUEST_ID_REQUIRED', 'A stable payment request and channel ID are required.');
      amount(body.amountSats, true); amount(body.quotedFeeSats); amount(body.feeratePerkw, true);
      scriptFor(body.address, this.record.network);
      const state = this.load();
      const previous = state.activity.find(row => row.requestId === body.requestId);
      if (previous) {
        if (['address', 'amountSats', 'channelId', 'feeratePerkw'].some(key => previous[key] !== body[key])) refuse('REQUEST_ID_CONFLICT', 'This payment request ID was already used.', 409);
        return { ok: true, operationId: previous.id, status: previous.status };
      }
      if (state.activity.some(row => row.channelId === body.channelId && ['pending', 'uncertain'].includes(row.status)))
        refuse('PAYMENT_IN_PROGRESS', 'This channel has a payment awaiting verification. Check Activity before sending again.', 409);
      if (state.activity.length >= 5000) refuse('WALLET_METADATA_FULL', 'The payment history is full.', 503);
      const channel = (await this.call('GET', '/channels')).find(item => item.channelId === body.channelId);
      if (!channel) refuse('NOT_FOUND', 'The payment channel is unavailable.', 409);
      const quote = await this.call('POST', '/channel/splice-quote', {
        channelId: body.channelId, direction: 'out', amountSats: body.amountSats,
        feeratePerkw: body.feeratePerkw, address: body.address,
      });
      if (!Number.isSafeInteger(quote.feeSats) || !Number.isSafeInteger(quote.maxAmountSats) || quote.feeSats > body.quotedFeeSats || quote.maxAmountSats < body.amountSats)
        refuse('QUOTE_EXPIRED', 'The balance or fee changed. Review the payment again.', 409);
      const row = {
        id: `submission:${body.requestId}`, requestId: body.requestId, kind: 'sent', title: 'Bitcoin payment pending',
        reference: body.requestId, timestamp: Date.now(), status: 'uncertain', amountSats: body.amountSats,
        feeSats: body.quotedFeeSats, feeKnown: true, feeEstimated: true, address: body.address,
        channelId: body.channelId, previousFundingTxid: channel.fundingTxid,
        previousFundingOutputIndex: channel.fundingOutputIndex, feeratePerkw: body.feeratePerkw,
        description: String(body.description ?? '').slice(0, 300),
      };
      this.commit({ ...state, activity: [...state.activity, row] });
      // The durable uncertain row must exist before the engine can put money
      // on the wire. An interrupted request never causes an automatic retry.
      const result = await this.call('POST', '/channel/splice-out', body);
      const txid = result?.txid ?? result?.spliceTxid;
      const transaction = typeof txid === 'string' && /^[a-f0-9]{64}$/.test(txid) ? { txid, reference: txid } : {};
      this.commit({ ...this.load(), activity: this.load().activity.map(item => item.id === row.id ? { ...item, status: 'pending', ...transaction } : item) });
      return { ...result, operationId: row.id, status: 'pending' };
    });
  }
  activity() {
    return this.serial(async () => {
      const state = this.load();
      if (!state.activity.length) return [];
      const channels = await this.call('GET', '/channels');
      const rows = clone(state.activity);
      for (const row of rows) {
        if (row.status === 'failed') continue;
        const channel = channels.find(item => item.channelId === row.channelId);
        const candidate = row.txid ?? [channel?.pendingSpliceTxid, channel?.fundingTxid].find(txid => txid && txid !== row.previousFundingTxid);
        if (!candidate) continue;
        try {
          const raw = await this.query('blockchain.transaction.get', [candidate, false]);
          const tx = Transaction.fromHex(raw);
          const script = scriptFor(row.address, this.record.network);
          if (tx.getId() !== candidate || !tx.ins.some(input => Buffer.from(input.hash).reverse().toString('hex') === row.previousFundingTxid && input.index === row.previousFundingOutputIndex) || !tx.outs.some(output => output.script.equals(script) && output.value === row.amountSats)) continue;
          const hash = crypto.createHash('sha256').update(script).digest().reverse().toString('hex');
          const history = await this.query('blockchain.scripthash.get_history', [hash]);
          const entry = history.find(item => item.tx_hash === candidate);
          if (!entry) continue;
          row.txid = candidate; row.reference = candidate;
          row.status = entry.height > 0 ? 'completed' : 'pending';
          row.title = entry.height > 0 ? 'Bitcoin sent' : 'Bitcoin payment pending';
        } catch { /* A failed evidence lookup preserves the known outcome. */ }
      }
      if (JSON.stringify(rows) !== JSON.stringify(state.activity)) this.commit({ ...state, activity: rows });
      return clone(rows);
    });
  }
}

function mountBrowserWalletApi(app, manager) {
  const stores = new Map();
  const get = id => {
    const record = manager.registry.get(id);
    if (!record) refuse('NOT_FOUND', 'Wallet not found.', 404);
    if (!stores.has(id)) stores.set(id, new BrowserWallet({
      record, file: path.join(manager.paths(id).base, 'browser-wallet.json'),
      call: (method, route, body) => manager._daemonCall(record, method, route, body),
      query: async (method, params) => {
        const { replies } = await electrumRequests(manager.registry.get(id).electrum, [{ id: 1, method, params }], { timeoutMs: 5000 });
        if (replies[1]?.error) refuse('CHAIN_EVIDENCE_UNAVAILABLE', 'Bitcoin evidence could not be read.', 503);
        return replies[1]?.result;
      },
    }));
    return stores.get(id);
  };
  const handle = operation => (req, res, next) => Promise.resolve().then(() => operation(req)).then(result => { res.setHeader('Cache-Control', 'no-store'); res.json({ ok: true, result }); }).catch(next);
  app.get('/api/wallets/:id/activity', handle(req => get(req.params.id).activity()));
  const router = express.Router({ mergeParams: true });
  // Beignet 0.36.1 documents outgoing amountSats as the rounded total debit.
  // Name that wire meaning explicitly. A future engine must be verified
  // before opting into this projection; older recipient-amount APIs must not
  // have their fees subtracted a second time.
  router.get('/payments', handle(async req => {
    const record = manager.registry.get(req.params.id);
    if (!record) refuse('NOT_FOUND', 'Wallet not found.', 404);
    const rows = await manager._daemonCall(record, 'GET', '/payments');
    if (manager.engineVersion !== '0.36.1') return rows;
    return rows.map(row => row.direction === 'OUTGOING' && row.status === 'COMPLETED' && !row.payAll
      ? { ...row, amountSemantics: 'total-debit-including-fee' } : row);
  }));
  router.get('/receive/requests', handle(req => ({ requests: get(req.params.id).requests() })));
  router.get('/receive/onchain', handle(req => get(req.params.id).receipts(req.query.address)));
  router.post('/address/new', express.json({ limit: '64kb' }), handle(req => get(req.params.id).allocate(req.body)));
  router.post('/receive/requests', express.json({ limit: '64kb' }), handle(async req => ({ request: await get(req.params.id).register(req.body?.request) })));
  router.post('/channel/splice-out', express.json({ limit: '64kb' }), handle(req => get(req.params.id).submitSplice(req.body)));
  app.use('/wallets/:id/api', router);
}

module.exports = { BrowserWallet, mountBrowserWalletApi, atomicSave };
