/** The operating system protects this app. Renderer preferences cannot gate a wallet. */
export type BiometryKind = 'face' | 'fingerprint' | 'iris' | 'passcode';
export const BIOMETRY_NAMES: Record<BiometryKind, string> = {
  face: 'Face ID', fingerprint: 'fingerprint', iris: 'iris recognition', passcode: 'your device passcode',
};
export async function supportedBiometry(): Promise<null> { return null; }
export async function isLockEnabled(): Promise<boolean> { return false; }
export function onLockChanged(_listener: (enabled: boolean) => void): () => void { return () => {}; }
export async function setLockEnabled(enabled: boolean): Promise<void> {
  if (enabled) throw new Error('App-specific biometric lock is unavailable. Lock your computer to protect access.');
}
export async function authenticate(_prompt: string): Promise<boolean> { return false; }
/** No renderer lock exists. The authenticated local service authorizes this request. */
export async function requireUnlock(_prompt: string): Promise<boolean> { return true; }
