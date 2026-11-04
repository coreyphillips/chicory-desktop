'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');

const REPORT_FORMAT = 1;
const EVENT_LIMIT = 40;
const OUTCOME_LIMIT = 5;
const OUTPUT_LIMIT = 20;
// A recovery phrase has at most 24 words, so wrapped one word per line it
// spans 24 lines. Each kept line is redacted with this many lines before it.
const CONTEXT_LINES = 23;
const MESSAGE_LIMIT = 300;
const FILE_LIMIT = 64 * 1024;
const INPUT_LIMIT = 256 * 1024;
const REPORT_LIMIT = 128 * 1024;
// Counters older than this are shown as stale even without a suspend.
const STALE_MS = 2 * 60 * 1000;
const CODE = /^[A-Z][A-Z0-9_]{0,47}$/;
// Field names whose values are secrets or identify a payment, peer or path.
const SENSITIVE_FIELD = /key|token|secret|password|passphrase|mnemonic|seed|cookie|credential|macaroon|preimage|xprv|xpub|txid|channelid|paymenthash|invoice|address|uri|host|path|^id$|walletid|nodeid|name/i;

function now() { return Date.now(); }
const iso = at => new Date(at).toISOString();
const clip = (text, limit) => (text.length > limit ? `${text.slice(0, limit - 3)}...` : text);

/**
 * Removes secrets and identifiers from free text before it is kept or copied.
 * Over-redaction is accepted: a support report never needs these values.
 */
function redactText(value, { paths = [], limit = MESSAGE_LIMIT, input = 16384 } = {}) {
  // Bound the regex work on runaway input. The cut is far past `limit`, so a
  // phrase split by it cannot shift into the kept text.
  let text = String(value ?? '').slice(0, input);
  for (const [prefix, label] of paths) text = text.split(prefix).join(label);
  text = text
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1[redacted]@')
    .replace(/\b(bearer|basic)\s+[\w.~+/=-]+/gi, '$1 [redacted]')
    // Before the assignment rule, which would take a phrase's first word and
    // leave the rest too short to match.
    .replace(/\b(?:[a-z]{3,8}\s+){11,23}[a-z]{3,8}\b/g, '[redacted words]')
    .replace(/\b([\w-]*(?:key|token|secret|password|passphrase|mnemonic|seed|cookie|auth)[\w-]*"?\s*[=:]\s*)(?!\[redacted)("[^"]*"|'[^']*'|[^\s,;&]+)/gi, '$1[redacted]')
    .replace(/\bln(?:bcrt|bc|tbs|tb|sb)[0-9a-z]{20,}/gi, '[redacted invoice]')
    .replace(/\blnurl[0-9a-z]{20,}/gi, '[redacted lnurl]')
    .replace(/\b(?:bcrt|bc|tb)1[0-9a-z]{20,}/gi, '[redacted address]')
    .replace(/\b[a-z2-7]{56}\.onion\b/gi, '[onion]')
    .replace(/\b[0-9a-f]{32,}\b/gi, '[redacted hex]')
    .replace(/(?:\/(?:Users|home)\/|[A-Za-z]:\\(?:Users|Documents and Settings)\\)[^/\\\s"']+/g, '<home>')
    .replace(/[A-Za-z0-9+/_-]{40,}={0,2}/g, '[redacted]')
    .replace(/\b[13mn2][a-km-zA-HJ-NP-Z1-9]{25,39}\b/g, '[redacted address]');
  return clip(text, limit);
}

/** Copies a structured value with sensitive fields removed and every string redacted. */
function redactValue(value, options = {}, depth = 0) {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return redactText(value, options);
  if (typeof value !== 'object') return undefined;
  if (depth >= 6) return '[truncated]';
  if (Array.isArray(value)) {
    const items = value.slice(0, 50).map(item => redactValue(item, options, depth + 1));
    if (value.length > 50) items.push(`[${value.length - 50} more]`);
    return items;
  }
  const result = {};
  let fields = 0;
  for (const [name, item] of Object.entries(value)) {
    if (++fields > 80) { result.truncated = true; break; }
    result[name] = SENSITIVE_FIELD.test(name) && item !== null ? '[redacted]' : redactValue(item, options, depth + 1);
  }
  return result;
}

const errorCode = error => (CODE.test(String(error?.code ?? '')) ? error.code : 'UNKNOWN');

/**
 * A figure with how much it can be trusted. `unsupported` is a figure this
 * platform cannot measure, `unavailable` one that could not be read now, and
 * `stale` one read before the last resume or too long ago. None of them is 0.
 */
function measured(value, at, { current = now(), since = 0, staleMs = STALE_MS } = {}) {
  if (value === undefined) return { state: 'unsupported', value: null };
  if (value === null || !Number.isFinite(at)) return { state: 'unavailable', value: null };
  const fresh = at >= since && current - at <= staleMs;
  return { state: fresh ? 'current' : 'stale', value, at: iso(at) };
}

function writePrivate(file, text) {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}-${randomBytes(6).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(temporary, text, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally {
    try { fs.unlinkSync(temporary); } catch {}
  }
}

function readPrevious(file, options) {
  if (!file) return null;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > FILE_LIMIT) return null;
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (saved?.format !== REPORT_FORMAT) return null;
    // Re-redact on load in case an older build kept more than this one would.
    return redactValue(saved, options);
  } catch { return null; }
}

/**
 * Records the desktop, storage, manager and Tor lifecycle in bounded memory,
 * persists only redacted outcomes and failures, and builds the support report
 * on request. Nothing here polls: counters are read when a report is asked for.
 */
class DesktopDiagnostics {
  constructor({ file = null, clock = now, versions = {}, paths = [], write = writePrivate, staleMs = STALE_MS } = {}) {
    this.file = file;
    this.clock = clock;
    this.write = write;
    this.staleMs = staleMs;
    this.options = { paths: paths.filter(([prefix]) => typeof prefix === 'string' && prefix.length > 1)
      .sort((a, b) => b[0].length - a[0].length) };
    this.versions = { ...versions };
    const at = iso(clock());
    this.lifecycle = Object.fromEntries(['app', 'storage', 'manager', 'tor'].map(name =>
      [name, { state: name === 'app' ? 'starting' : 'stopped', since: at }]));
    this.events = [];
    this.startups = [];
    this.shutdowns = [];
    this.output = [];
    this.partial = '';
    this.torState = null;
    this.power = { suspends: 0, suspendedAt: null, resumedAt: null };
    this.resumedAt = 0;
    this.startupAt = null;
    this.shutdownAt = null;
    this.previous = readPrevious(file, this.options);
  }

  record(kind, message, code) {
    this.events.push({ at: iso(this.clock()), kind, ...(code ? { code } : {}), message: redactText(message, this.options) });
    if (this.events.length > EVENT_LIMIT) this.events.splice(0, this.events.length - EVENT_LIMIT);
  }

  state(component, state, error) {
    const previous = this.lifecycle[component];
    const code = error ? errorCode(error) : undefined;
    if (previous?.state === state && previous.code === code) return;
    this.lifecycle[component] = { state, since: iso(this.clock()), ...(code ? { code } : {}) };
    this.record(component, error ? `${state}: ${error.message || ''}` : state, code);
  }

  startupBegan() {
    this.startupAt = this.clock();
    this.state('app', 'starting');
  }

  startupEnded(outcome, error) {
    const at = this.clock();
    this.startups.push({ at: iso(at), outcome, durationMs: this.startupAt === null ? null : at - this.startupAt,
      ...(error ? { code: errorCode(error), message: redactText(error.message, this.options) } : {}) });
    if (this.startups.length > OUTCOME_LIMIT) this.startups.shift();
    this.state('app', outcome === 'ready' ? 'ready' : outcome, error);
    this.persist();
  }

  shutdownBegan() {
    this.shutdownAt = this.clock();
    this.state('app', 'stopping');
  }

  /** `manager` is how the manager stopped: exited, timeout or not-running. */
  shutdownEnded({ manager, tor }) {
    const at = this.clock();
    const outcome = manager === 'timeout' ? 'timeout' : manager === 'failed' || tor === 'failed' ? 'incomplete' : 'clean';
    this.shutdowns.push({ at: iso(at), outcome, manager, tor, durationMs: this.shutdownAt === null ? null : at - this.shutdownAt });
    if (this.shutdowns.length > OUTCOME_LIMIT) this.shutdowns.shift();
    this.state('app', 'stopped');
    if (outcome !== 'clean') this.record('shutdown', `shutdown ${outcome}: manager ${manager}, tor ${tor}`, 'SHUTDOWN_TIMEOUT');
    this.persist();
  }

  torStatus(status) {
    if (!status || typeof status.phase !== 'string') return;
    const progress = Number.isInteger(status.progress) ? status.progress : null;
    this.torState = { phase: status.phase, progress, error: status.error ? redactText(status.error, this.options) : null, at: this.clock() };
    this.state('tor', status.phase, status.phase === 'failed' ? { code: 'TOR_UNAVAILABLE', message: status.error || '' } : undefined);
    if (status.phase === 'failed') this.persist();
  }

  managerExited({ code, signal, expected }) {
    const reason = `exit code ${code ?? 'none'}, signal ${signal ?? 'none'}`;
    if (expected) this.state('manager', 'stopped');
    else { this.state('manager', 'crashed', { code: 'MANAGER_EXITED', message: reason }); this.persist(); }
  }

  /**
   * Keeps the last lines of the manager's error stream in memory only. They
   * are redacted together when read, so a phrase wrapped across lines or
   * chunks is still caught.
   */
  managerOutput(chunk) {
    const lines = (this.partial + String(chunk)).split(/\r?\n/);
    this.partial = lines.pop().slice(-1024);
    for (const line of lines) if (line.trim()) this.output.push(line.slice(0, 1024));
    const keep = OUTPUT_LIMIT + CONTEXT_LINES;
    if (this.output.length > keep) this.output.splice(0, this.output.length - keep);
  }

  outputTail() {
    if (!this.output.length) return [];
    const text = redactText(this.output.join('\n'), { ...this.options, limit: Infinity, input: Infinity });
    return text.split('\n').slice(-OUTPUT_LIMIT).map(line => clip(line, MESSAGE_LIMIT));
  }

  suspend() {
    this.power.suspends += 1;
    this.power.suspendedAt = iso(this.clock());
    if (this.lifecycle.app.state !== 'suspended') this.beforeSuspend = this.lifecycle.app.state;
    this.state('app', 'suspended');
  }

  resume() {
    this.resumedAt = this.clock();
    this.power.resumedAt = iso(this.resumedAt);
    if (this.lifecycle.app.state === 'suspended') this.state('app', this.beforeSuspend || 'ready');
  }

  measure(value, at) {
    return measured(value, at, { current: this.clock(), since: this.resumedAt, staleMs: this.staleMs });
  }

  /** What is worth keeping across launches: outcomes and failures, never wallet figures. */
  saved() {
    const failed = ['failed', 'crashed'].some(state => Object.values(this.lifecycle).some(entry => entry.state === state)) ||
      this.startups.at(-1)?.outcome === 'failed';
    return { format: REPORT_FORMAT, savedAt: iso(this.clock()), versions: this.versions, lifecycle: this.lifecycle,
      startups: this.startups, shutdowns: this.shutdowns, events: this.events, ...(failed ? { managerOutput: this.outputTail() } : {}) };
  }

  persist() {
    if (!this.file) return;
    try {
      const text = JSON.stringify(this.saved());
      if (text.length <= FILE_LIMIT) this.write(this.file, text);
    } catch {}
  }

  /**
   * The report as shown and copied. `desktop` and `manager` are counters read
   * for this request; `wallet` is the open wallet's own report, if any.
   */
  report({ desktop, manager, wallet, walletError, events } = {}) {
    const current = this.clock();
    const managerAt = Number.isFinite(manager?.at) ? manager.at : null;
    const tor = this.torState;
    const transport = wallet && typeof wallet === 'object' ? {
      primary: typeof wallet.primaryTransport === 'string' ? wallet.primaryTransport : null,
      // The engine measures round trips only on iroh paths.
      rttMs: this.measure(Number.isFinite(wallet.primaryRttMs) ? wallet.primaryRttMs
        : String(wallet.primaryTransport).startsWith('iroh') ? null : undefined, Number(wallet.checkedAt)),
    } : { primary: null, rttMs: { state: 'unavailable', value: null } };
    const report = {
      format: REPORT_FORMAT,
      generatedAt: iso(current),
      versions: { ...this.versions, engine: manager?.engineVersion ?? null, managerNode: manager?.node ?? null,
        vault: manager?.vaultFormat ?? null },
      lifecycle: this.lifecycle,
      startups: this.startups,
      shutdowns: this.shutdowns,
      power: this.power,
      // Tor reports every change, so its status only goes stale across a suspend.
      tor: tor ? { phase: tor.phase, error: tor.error,
        progress: measured(tor.progress, tor.at, { current, since: this.resumedAt, staleMs: Infinity }) }
        : { phase: this.lifecycle.tor.state, progress: { state: 'unavailable', value: null }, error: null },
      transport: { proxy: 'bundled-tor', ...transport },
      resources: {
        desktop: desktop ? this.measure(desktop, current) : { state: 'unavailable', value: null },
        manager: manager ? this.measure(redactValue(manager.resources ?? null, this.options), managerAt)
          : { state: 'unavailable', value: null },
        engines: manager?.wallets ? redactValue(manager.wallets, this.options) : { state: 'unavailable' },
        tor: { state: 'unsupported' },
      },
      events: this.events,
      managerOutput: this.outputTail(),
      // redactValue keeps an array's first 50 items, so the newest are picked here.
      ...(Array.isArray(events) ? { appEvents: redactValue(events.slice(-50), this.options) } : {}),
      ...(walletError ? { walletError: redactText(walletError, this.options) } : {}),
      ...(wallet ? { wallet: redactValue(wallet, this.options) } : {}),
      ...(this.previous ? { previousSession: { ...this.previous, state: 'stale' } } : {}),
    };
    return report;
  }

  text(input) {
    let text = JSON.stringify(this.report(input), null, 1);
    if (text.length > REPORT_LIMIT) {
      const { wallet, appEvents, ...rest } = this.report(input);
      text = JSON.stringify({ ...rest, truncated: true }, null, 1);
    }
    return text;
  }
}

/**
 * Asks a child to stop and kills it at the deadline. Resolves with how it
 * stopped, so a shutdown that needed the kill is reported as a timeout.
 */
function stopChild(child, { timeoutMs = 45000, message = { type: 'shutdown' } } = {}) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve('not-running');
  return new Promise(resolve => {
    let outcome = 'exited';
    const deadline = setTimeout(() => { outcome = 'timeout'; child.kill('SIGKILL'); }, timeoutMs);
    // SIGTERM is a stop request, sent below when there is no IPC channel. Any
    // other signal is a crash.
    child.once('exit', (code, signal) => { clearTimeout(deadline);
      resolve(outcome === 'exited' && (code || (signal && signal !== 'SIGTERM')) ? 'failed' : outcome); });
    if (child.connected) child.send(message, () => {});
    else child.kill('SIGTERM');
  });
}

/** Desktop process counters, from Electron's own per-process metrics. */
function desktopResources(metrics, memory) {
  const list = Array.isArray(metrics) ? metrics : [];
  return {
    processes: list.length,
    workingSetKb: list.reduce((sum, item) => sum + (Number(item.memory?.workingSetSize) || 0), 0),
    cpuPercent: Math.round(list.reduce((sum, item) => sum + (Number(item.cpu?.percentCPUUsage) || 0), 0) * 10) / 10,
    mainRssKb: memory ? Math.round(memory.rss / 1024) : null,
  };
}

module.exports = { DesktopDiagnostics, redactText, redactValue, measured, stopChild, desktopResources,
  INPUT_LIMIT, EVENT_LIMIT, OUTCOME_LIMIT, OUTPUT_LIMIT, FILE_LIMIT };
