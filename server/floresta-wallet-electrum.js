'use strict';

const { createHash } = require('node:crypto');
const { Transaction, address, networks, script } = require('bitcoinjs-lib');
const { GENESIS_CHAINS } = require('./electrum-probe');

const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const uint = value => Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff;
const unavailable = () => new Error('Wallet observations are unavailable.');

function verbose(proof, network) {
  const tx = Transaction.fromHex(proof.hex);
  if (tx.getId() !== proof.txid) throw unavailable();
  const vin = tx.ins.map(input => ({ ...(tx.isCoinbase() ? { coinbase: input.script.toString('hex') } :
    { txid: Buffer.from(input.hash).reverse().toString('hex'), vout: input.index,
      scriptSig: { hex: input.script.toString('hex'), asm: script.toASM(input.script) } }),
    sequence: input.sequence, ...(input.witness.length && { txinwitness: input.witness.map(item => item.toString('hex')) }) }));
  const vout = tx.outs.map((out, n) => {
    let dest;
    try { dest = address.fromOutputScript(out.script, network); } catch { /* e.g. OP_RETURN */ }
    return { n, value: out.value / 1e8, scriptPubKey: { hex: out.script.toString('hex'), asm: script.toASM(out.script),
      ...(dest && { address: dest, addresses: [dest] }) } };
  });
  const time = proof.header ? Buffer.from(proof.header, 'hex').readUInt32LE(68) : null;
  return { hex: proof.hex, txid: tx.getId(), hash: proof.wtxid, version: tx.version, size: tx.byteLength(), vsize: tx.virtualSize(),
    weight: tx.weight(), locktime: tx.locktime, vin, vout, confirmations: proof.confirmations,
    ...(time !== null && { blockhash: proof.blockHash, time, blocktime: time }) };
}

function walletElectrum({ qualification, network, status, confirmed, pending, readHeader, estimateFee, broadcast }) {
  if (qualification !== true || network !== 'regtest') throw new Error('Wallet reads require a disposable regtest fixture.');
  const genesis = Object.keys(GENESIS_CHAINS).find(hash => GENESIS_CHAINS[hash] === network);
  const bitcoinNetwork = networks.regtest;
  const subscriptions = new Map();
  let subscribedTip;
  async function tip() {
    const state = await status();
    if (state.network !== network || state.phase !== 'running' || state.historicalVerification !== 'verified' || !state.tipSynced ||
        !uint(state.height) || state.height !== state.validatedHeight || !hash(state.tipHash)) throw unavailable();
    return { tipHash: state.tipHash, tipHeight: state.height };
  }
  function anchored(view, anchor) {
    if (!view || view.tipHash !== anchor.tipHash || view.tipHeight !== anchor.tipHeight) throw unavailable();
    return view;
  }
  async function header(height, anchor) {
    if (!uint(height) || height > anchor.tipHeight) throw unavailable();
    const hex = await readHeader(height, anchor);
    if (typeof hex !== 'string' || !/^[a-f0-9]{160}$/.test(hex)) throw unavailable();
    const id = createHash('sha256').update(createHash('sha256').update(Buffer.from(hex, 'hex')).digest()).digest().reverse().toString('hex');
    if ((height === 0 && id !== genesis) || (height === anchor.tipHeight && id !== anchor.tipHash)) throw unavailable();
    return hex;
  }
  async function scriptRead(method, scriptHash, anchor, mem) {
    if (mem.scope !== 'observed-pending' || mem.coverageComplete !== false) throw unavailable();
    const pendingRows = [...mem.rows].sort((a, b) => b.height - a.height || a.txid.localeCompare(b.txid));
    const observed = pendingRows.map(row => ({ tx_hash: row.txid, height: row.height, fee: row.fee }));
    if (method === 'get_mempool') return observed;
    if (method === 'get_history' || method === 'subscribe') {
      const history = anchored(await confirmed.history(scriptHash), anchor);
      if (history.scope !== 'confirmed-only') throw unavailable();
      const rows = history.rows.map(row => ({ tx_hash: row.txid, height: row.height })).concat(observed);
      if (method === 'get_history') return rows;
      return rows.length ? createHash('sha256').update(rows.map(row => `${row.tx_hash}:${row.height}:`).join('')).digest('hex') : null;
    }
    const unspent = anchored(await confirmed.unspent(scriptHash), anchor);
    if (unspent.scope !== 'confirmed-only') throw unavailable();
    const spent = new Set();
    const created = [];
    let delta = 0;
    for (const row of pendingRows) {
      for (const input of row.spent) { spent.add(input.txid + ':' + input.vout); delta -= input.value; }
      for (const out of row.created) { created.push({ tx_hash: row.txid, tx_pos: out.vout, value: out.value, height: row.height }); delta += out.value; }
    }
    if (method === 'get_balance') return { confirmed: unspent.rows.reduce((sum, row) => sum + row.value, 0), unconfirmed: delta };
    return unspent.rows.map(row => ({ tx_hash: row.txid, tx_pos: row.vout, height: row.height, value: row.value })).concat(created)
      .filter(coin => !spent.has(coin.tx_hash + ':' + coin.tx_pos));
  }
  async function call(method, params) {
    if (!Array.isArray(params)) throw unavailable();
    if (method === 'server.version') {
      const version = params[1];
      if (version !== '1.4' && !(Array.isArray(version) && version.length === 2 && version[0] === '1.4' && /^1\.4(?:\.|$)/.test(version[1]))) throw unavailable();
      return ['Chicory managed qualification', '1.4'];
    }
    if (method === 'server.ping') return null;
    if (method === 'server.features') return { genesis_hash: genesis, protocol_min: '1.4', protocol_max: '1.4',
      server_version: 'Chicory managed qualification', chicory: { walletReady: false, pendingCoverage: 'observed-only' } };
    const anchor = await tip();
    let result;
    if (method === 'blockchain.block.header') result = await header(params[0], anchor);
    else if (method === 'blockchain.headers.subscribe') {
      result = { height: anchor.tipHeight, hex: await header(anchor.tipHeight, anchor) };
      subscribedTip = anchor.tipHash;
    } else if (/^blockchain\.scripthash\.(?:get_history|get_mempool|get_balance|listunspent|subscribe)$/.test(method)) {
      const action = method.split('.').at(-1);
      if (action === 'subscribe' && !subscriptions.has(params[0]) && subscriptions.size >= 1024) throw unavailable();
      if (!hash(params[0])) throw unavailable();
      const mem = anchored(await pending.observations(params[0]), anchor);
      result = await scriptRead(action, params[0], anchor, mem);
      const latest = anchored(await pending.observations(params[0]), anchor);
      if (latest.revision !== mem.revision || latest.scope !== 'observed-pending' || latest.coverageComplete !== false) throw unavailable();
      if (action === 'subscribe') subscriptions.set(params[0], result);
    } else if (method === 'blockchain.transaction.get' && hash(params[0]) && (params[1] === undefined || typeof params[1] === 'boolean')) {
      const proof = anchored(await confirmed.transaction(params[0]) ?? await pending.transaction(params[0]), anchor);
      if ((proof.scope !== 'confirmed-only' && !(proof.scope === 'observed-pending' && proof.coverageComplete === false && proof.confirmations === 0)) ||
          proof.txid !== params[0]) throw unavailable();
      result = params[1] ? verbose(proof, bitcoinNetwork) : proof.hex;
    } else if (method === 'blockchain.transaction.get_merkle' && hash(params[0]) && uint(params[1])) {
      const proof = anchored(await confirmed.merkle(...params), anchor);
      if (proof.scope !== 'confirmed-only' || proof.height !== params[1]) throw unavailable();
      result = { block_height: proof.height, pos: proof.position, merkle: proof.merkle };
    } else if (method === 'blockchain.estimatefee' && uint(params[0]) && params[0] > 0) {
      result = estimateFee ? await estimateFee(params[0], anchor) : -1;
      if (!Number.isFinite(result) || (result !== -1 && result <= 0)) throw unavailable();
    } else if (method === 'blockchain.transaction.broadcast' && broadcast && typeof params[0] === 'string' && params[0].length <= 60000 && params[0].length % 2 === 0 && /^[0-9a-f]+$/.test(params[0])) {
      const sent = Transaction.fromHex(params[0]).getId();
      result = await broadcast(params[0], anchor);
      if (result !== sent) throw unavailable();
      return result;
    } else throw unavailable();
    anchored(await tip(), anchor);
    return result;
  }
  async function refresh(notify) {
    const anchor = await tip();
    if (subscribedTip && subscribedTip !== anchor.tipHash) {
      await notify('blockchain.headers.subscribe', [await call('blockchain.headers.subscribe', [])]);
    }
    for (const [scriptHash, previous] of subscriptions) {
      const current = await call('blockchain.scripthash.subscribe', [scriptHash]);
      if (previous !== current) await notify('blockchain.scripthash.subscribe', [scriptHash, current]);
    }
  }
  return { call, refresh };
}

module.exports = { walletElectrum };
