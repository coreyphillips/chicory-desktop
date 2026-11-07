'use strict';

const { validateTransactionChunk } = require('./floresta-transactions.cjs');
const { validateConfirmedPage } = require('./floresta-confirmed-reads.cjs');
const { validatePendingPage, PENDING_LINE_BYTES } = require('./floresta-pending-reads.cjs');

const PROTOCOL = 'chicory.watch/1';
const hexHash = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const uint = value => Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
const outpoint = value => typeof value === 'string' && /^[0-9a-f]{64}:(0|[1-9][0-9]{0,9})$/.test(value) && uint(Number(value.slice(65)));
const script = value => typeof value === 'string' && /^(?:[a-f0-9]{2}){1,10000}$/.test(value);
const phases = ['registered', 'scanning', 'caught-up', 'unavailable'];

// Beignet exports BIP 380 descriptors using standard public account keys.
// Recognize only its wallet descriptor shapes before anything reaches the pipe.
function publicRange(item) {
  if (!item || Object.keys(item).some(k => !['descriptor', 'range'].includes(k)) ||
      typeof item.descriptor !== 'string' || item.descriptor.length > 512 || !Array.isArray(item.range) || item.range.length !== 2) return false;
  const [start, end] = item.range;
  if (!uint(start) || !uint(end) || end >= 0x80000000 || end < start || end - start >= 256) return false;
  const shape = item.descriptor.replace(/(?:\[[a-f0-9]{8}(?:\/[0-9]+[h']?)*\])?(?:xpub|tpub)[1-9A-HJ-NP-Za-km-z]{107,108}\/[01]\/\*/g, '@')
    .replace(/#[a-z0-9]{8}$/, '');
  return !item.descriptor.includes('@') && /^(?:(?:pkh|wpkh|tr)\(@\)|sh\(wpkh\(@\)\)|wsh\(sortedmulti\([1-9][0-9]*(?:,@)+\)\))$/.test(shape);
}

function register({ owner, scripts, outpoints, descriptors = [], ...extra }) {
  if (!hexHash(owner) || Object.keys(extra).length || !Array.isArray(scripts) || !Array.isArray(outpoints) ||
      !Array.isArray(descriptors) || !(scripts.length || outpoints.length || descriptors.length) ||
      scripts.length + outpoints.length + descriptors.length > 1024 || !scripts.every(script) ||
      !outpoints.every(outpoint) || !descriptors.every(publicRange)) throw new Error('Invalid public local node watches.');
  return { action: 'register', owner, scripts, outpoints, descriptors };
}

function coverage(owner) {
  if (!hexHash(owner)) throw new Error('Invalid local node watch owner.');
  return { action: 'coverage', owner };
}

function validated(value) {
  if (!phases.includes(value?.phase) || !uint(value.requiredScripts) || !uint(value.requiredOutpoints) || !uint(value.matchedTransactions) ||
      !(value.height === null && value.hash === null || uint(value.height) && hexHash(value.hash)) ||
      (value.phase === 'caught-up' && value.height === null)) throw new Error('Invalid local node watch coverage.');
  const { phase, height, hash, requiredScripts, requiredOutpoints, matchedTransactions } = value;
  return { phase, height, hash, requiredScripts, requiredOutpoints, matchedTransactions };
}

// Each instance belongs to one authenticated child pipe. Neither commands nor
// uncertain registrations carry over to a replacement child.
class WatchRequests {
  constructor(write, fail, timeoutMs = 30000) {
    this.write = write;
    this.fail = fail;
    this.timeoutMs = timeoutMs;
    this.requests = new Map();
    this.id = 0;
    this.active = false;
    this.lifetime = new AbortController();
  }
  async request(command) {
    if (!this.active) throw new Error('The running local node cannot accept watch requests.');
    if (this.requests.size >= 16) throw new Error('Local node watch requests are busy. Retry after completion.');
    if (this.id === 0xffffffff) throw new Error('Local node watch request IDs exhausted. Restart the node.');
    const id = ++this.id;
    const line = JSON.stringify({ id, ...command }) + '\n';
    if (Buffer.byteLength(line) > 65536) throw new Error('Split large local node watch registrations into smaller requests.');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error('Local node watch acknowledgement timed out.')), this.timeoutMs);
      this.requests.set(id, { command, resolve, reject, timer });
      this.write(line);
    });
  }
  replyLimit(message) {
    if (this.pendingActive && message?.protocol === PROTOCOL &&
        this.requests.get(message.id)?.command.action === 'pending') return PENDING_LINE_BYTES;
    return 4096;
  }
  partialLimit() {
    if (this.pendingActive && [...this.requests.values()].some(r => r.command.action === 'pending')) return PENDING_LINE_BYTES;
    return 4096;
  }
  receive(reply) {
    const req = this.requests.get(reply.id);
    if (!req || reply.protocol !== PROTOCOL || Boolean(Object.hasOwn(reply, 'error')) === Object.hasOwn(reply, 'result')) {
      throw new Error('Unrecognized local node watch reply.');
    }
    const failed = Object.hasOwn(reply, 'error');
    if (failed && typeof reply.error !== 'string') throw new Error('Invalid local node watch error.');
    if (req.retired) {
      clearTimeout(req.timer);
      this.requests.delete(reply.id);
      return;
    }
    const validate = req.command.action === 'broadcast'
      ? (command, value) => {
          if (value?.phase !== 'relayed' || value.txid !== command.txid || value.tipHash !== command.offer.tip) {
            throw new Error('The managed wallet delivery receipt is invalid.');
          }
          return value.txid;
        }
      : req.command.action === 'pending-transaction'
      ? require('./floresta-pending-transaction.cjs').validatePendingChunk
      : { transaction: validateTransactionChunk, confirmed: validateConfirmedPage, pending: validatePendingPage }[req.command.action];
    const result = failed ? null : validate ? validate(req.command, reply.result) : validated(reply.result);
    clearTimeout(req.timer);
    this.requests.delete(reply.id);
    if (failed) req.reject(new Error('The local node refused this watch request.'));
    else req.resolve(result);
  }
  suspend(reason, drainMs) {
    this.active = false;
    this.lifetime.abort();
    // The child may have executed a request before its tip became unavailable.
    // Drain the known reply ID exactly once and never retry its operation.
    for (const req of this.requests.values()) {
      if (req.retired) continue;
      req.retired = true;
      clearTimeout(req.timer);
      req.timer = setTimeout(() => this.fail(new Error('The local node did not finish its previous control request.')), drainMs);
      req.reject(reason);
    }
  }
  close(reason) {
    this.active = false;
    this.lifetime.abort();
    for (const { reject, timer } of this.requests.values()) { clearTimeout(timer); reject(reason); }
    this.requests.clear();
  }
}

module.exports = { WatchRequests, PROTOCOL, register, coverage };
