import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const REGTEST_GENESIS = '0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206';
export const PROFILE_PREFIX = 'chicory-qualify-';

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

export class GuardError extends Error {
  constructor(message) { super(`Regtest guard: ${message}`); this.name = 'GuardError'; }
}

/** Destructive recovery exercises get a fresh fixture of their own. */
export function qualificationStages(selection) {
  // A stale backup may make its counterparty close, so backup runs last.
  const defaults = ['preflight', 'payments', 'direct-funding', 'restart', 'crash', 'persistence', 'offline', 'max', 'drain', 'recovery', 'transport', 'backup'];
  const remoteRecovery = ['guardian-recovery', 'peer-storage-recovery'];
  const standalone = [...remoteRecovery, 'forceclose-sweep', 'breach-justice'];
  const stages = new Set(selection ? selection.split(',').map(stage => stage.trim()).filter(Boolean) : defaults);
  for (const stage of stages) {
    if (!defaults.includes(stage) && !standalone.includes(stage) && stage !== 'floresta-preview')
      throw new GuardError('Unknown stage ' + stage);
  }
  const recoveryStage = remoteRecovery.find(stage => stages.has(stage));
  if (stages.size !== 1 && standalone.some(stage => stages.has(stage))) throw new GuardError('Run this funded scenario in a fresh isolated fixture.');
  return { stages, recoveryStage };
}

/** Electrum returns a raw 80-byte header. Its block hash is the reversed double SHA-256. */
export function headerHash(headerHex) {
  if (typeof headerHex !== 'string' || !/^[0-9a-f]{160}$/i.test(headerHex)) throw new GuardError('Electrum returned a malformed header.');
  const once = createHash('sha256').update(Buffer.from(headerHex, 'hex')).digest();
  return createHash('sha256').update(once).digest().reverse().toString('hex');
}

export function assertLoopback(host, label) {
  if (!LOOPBACK.has(String(host).replace(/^\[|\]$/g, ''))) throw new GuardError(`${label} must be loopback, got ${host}.`);
}

/** Both chain sources must independently report the regtest genesis block. */
export function assertRegtestChain({ chain, genesis, electrumHeader }) {
  if (chain !== 'regtest') throw new GuardError(`Bitcoin RPC reports chain ${chain}.`);
  if (genesis !== REGTEST_GENESIS) throw new GuardError(`Bitcoin RPC genesis ${genesis} is not regtest.`);
  if (headerHash(electrumHeader) !== REGTEST_GENESIS) throw new GuardError('Electrum genesis is not regtest.');
}

/** Regtest bech32 or legacy test prefixes only. Mainnet and testnet bech32 are refused. */
export function assertRegtestAddress(address) {
  const value = String(address);
  if (/^bcrt1[02-9ac-hj-np-z]{8,87}$/.test(value.toLowerCase()) || /^[mn2][1-9A-HJ-NP-Za-km-z]{25,34}$/.test(value)) return value;
  throw new GuardError(`Refusing to fund non-regtest address ${value.slice(0, 12)}.`);
}

/** The production profile locations main.cjs would use without CHICORY_PROFILE_DIR. */
export function productionProfiles({ platform = process.platform, home = os.homedir(), env = process.env } = {}) {
  const data = platform === 'darwin' ? path.join(home, 'Library/Application Support')
    : platform === 'win32' ? (env.APPDATA || path.join(home, 'AppData/Roaming'))
      : (env.XDG_CONFIG_HOME || path.join(home, '.config'));
  return ['Chicory Desktop', 'Chicory Desktop Demo', 'Chicory'].map(name => path.join(data, name));
}

/** realpath for a path that may not exist yet, through its nearest existing ancestor. */
function realish(target) {
  const absolute = path.resolve(target);
  if (fs.existsSync(absolute)) return fs.realpathSync(absolute);
  const parent = path.dirname(absolute);
  return parent === absolute ? absolute : path.join(realish(parent), path.basename(absolute));
}

function inside(child, parent) {
  const relative = path.relative(parent, child);
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * A qualification profile is a fresh mkdtemp directory under the OS temporary
 * directory that no production profile contains. `fresh` also requires it to
 * be empty, which is how a run proves it did not inherit wallet files.
 */
export function assertDisposableProfile(profile, { tmp = os.tmpdir(), fresh = true, production = productionProfiles() } = {}) {
  const resolved = fs.realpathSync(profile);
  const base = fs.realpathSync(tmp);
  if (!inside(resolved, base) || resolved === base) throw new GuardError(`Profile ${profile} is outside the temporary directory.`);
  if (!path.basename(resolved).startsWith(PROFILE_PREFIX)) throw new GuardError(`Profile ${profile} was not created by this suite.`);
  for (const candidate of production) {
    const real = realish(candidate);
    if (inside(resolved, real) || inside(real, resolved)) throw new GuardError(`Profile ${profile} overlaps production profile ${candidate}.`);
  }
  if (fresh && fs.readdirSync(resolved).length) throw new GuardError(`Profile ${profile} is not empty.`);
  return resolved;
}

export function assertRegtestWallets(wallets) {
  if (!Array.isArray(wallets)) throw new GuardError('Manager wallet list is malformed.');
  const other = wallets.find(record => record?.network !== 'regtest');
  if (other) throw new GuardError(`Manager contains a ${other?.network} wallet.`);
}

/**
 * Funding and mining go through this gate. Nothing can reach Bitcoin RPC's
 * spending or mining calls until `verify` has checked the chain, Electrum,
 * every app profile and every manager it will fund.
 */
export class RegtestGate {
  #verified = false;
  #rpc;
  constructor({ rpc }) { this.#rpc = rpc; }
  get verified() { return this.#verified; }

  verify({ chain, genesis, electrumHeader, electrum, managers = [] }) {
    assertLoopback(electrum.host, 'Electrum');
    assertRegtestChain({ chain, genesis, electrumHeader });
    // The desktop manager defaults to mainnet, so its default network proves
    // nothing. Every wallet it already holds must be regtest instead.
    for (const wallets of managers) assertRegtestWallets(wallets);
    this.#verified = true;
  }

  #require(action) { if (!this.#verified) throw new GuardError(`${action} attempted before regtest verification.`); }

  /** Re-checks the live chain on every call, so a swapped RPC target cannot be funded. */
  #recheck() {
    const info = this.#rpc('getblockchaininfo');
    if (info?.chain !== 'regtest') throw new GuardError(`Bitcoin RPC switched to ${info?.chain}.`);
  }

  fund(address, sats) {
    this.#require('Funding');
    if (!Number.isSafeInteger(sats) || sats <= 0 || sats > 50_000_000) throw new GuardError(`Refusing to fund ${sats} sats.`);
    assertRegtestAddress(address);
    this.#recheck();
    return this.#rpc('sendtoaddress', address, (sats / 1e8).toFixed(8));
  }

  mine(blocks = 1) {
    this.#require('Mining');
    if (!Number.isSafeInteger(blocks) || blocks < 1 || blocks > 200) throw new GuardError(`Refusing to mine ${blocks} blocks.`);
    this.#recheck();
    const address = assertRegtestAddress(this.#rpc('getnewaddress'));
    return this.#rpc('generatetoaddress', blocks, address);
  }
}
