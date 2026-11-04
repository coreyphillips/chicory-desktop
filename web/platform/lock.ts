/**
 * The desktop main process owns the app lock and refuses wallet routes while
 * it is locked. This adapter only asks it to prompt; nothing here can open the
 * gate. In a plain browser there is no lock and the local service authorizes.
 */
export type BiometryKind = 'face' | 'fingerprint' | 'iris' | 'passcode';
export const BIOMETRY_NAMES: Record<BiometryKind, string> = {
  face: 'face recognition', fingerprint: 'Touch ID', iris: 'iris recognition', passcode: 'Windows Hello',
};

export type LockEvent = 'locked' | 'unlocked' | 'conceal' | 'changed';
type Result = { ok: boolean; error?: string; reason?: string };
export interface DesktopLock {
  state(): Promise<{ enabled: boolean; locked: boolean; kind: BiometryKind | null }>;
  unlock(): Promise<Result>;
  setEnabled(enabled: boolean): Promise<Result>;
  authorize(): Promise<Result>;
  onEvent(callback: (name: string, value?: string | boolean) => void): () => void;
}

const UNAVAILABLE = 'App-specific biometric lock is unavailable. Lock your computer to protect access.';

function bridge(): DesktopLock | undefined {
  return typeof window === 'undefined' ? undefined : (window as { chicoryDesktop?: { lock?: DesktopLock } }).chicoryDesktop?.lock;
}

const KINDS = new Set<BiometryKind>(['face', 'fingerprint', 'iris', 'passcode']);

export async function supportedBiometry(): Promise<BiometryKind | null> {
  const lock = bridge();
  if (!lock) return null;
  try {
    const { kind } = await lock.state();
    return kind && KINDS.has(kind) ? kind : null;
  } catch { return null; }
}

export async function isLockEnabled(): Promise<boolean> {
  const lock = bridge();
  if (!lock) return false;
  // An unreadable answer shows the lock screen. The main process decides
  // whether it opens, so this cannot strand anyone the gate would admit.
  try { return (await lock.state()).enabled !== false; } catch { return true; }
}

export function onLockChanged(listener: (enabled: boolean) => void): () => void {
  return bridge()?.onEvent((name, value) => { if (name === 'changed' && typeof value === 'boolean') listener(value); }) ?? (() => {});
}

/** The main process relocked: screen lock, suspend or the background grace period. */
export function onRelock(listener: (reason: string) => void): () => void {
  return bridge()?.onEvent((name, value) => { if (name === 'locked') listener(typeof value === 'string' ? value : ''); }) ?? (() => {});
}

/** The window lost the foreground, or the screen locked: drop anything secret on screen. */
export function onConceal(listener: () => void): () => void {
  return bridge()?.onEvent(name => { if (name === 'conceal' || name === 'locked') listener(); }) ?? (() => {});
}

export async function setLockEnabled(enabled: boolean): Promise<void> {
  const lock = bridge();
  if (!lock) {
    if (enabled) throw new Error(UNAVAILABLE);
    return;
  }
  const result = await lock.setEnabled(enabled);
  if (!result?.ok) throw new Error(result?.error || 'Could not change the lock.');
}

/** Resolves false on a cancelled prompt; throws when the system cannot authenticate at all. */
export async function authenticate(_prompt: string): Promise<boolean> {
  const lock = bridge();
  if (!lock) return false;
  const result = await lock.unlock();
  if (result?.ok) return true;
  if (result?.reason === 'cancelled' || result?.reason === 'busy') return false;
  throw new Error(result?.error || 'Chicory stays locked until this is confirmed.');
}

/**
 * Fresh authentication before a recovery phrase or erase. With the lock on,
 * the main process only releases a recovery phrase after this succeeds.
 */
export async function requireUnlock(_prompt: string): Promise<boolean> {
  const lock = bridge();
  if (!lock) return true;
  const result = await lock.authorize();
  if (result?.ok) return true;
  if (result?.reason === 'cancelled' || result?.reason === 'busy' || result?.reason === 'failed') return false;
  throw new Error(result?.error || 'Authentication is unavailable.');
}
