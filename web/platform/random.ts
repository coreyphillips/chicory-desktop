import { Buffer } from 'buffer';
export function secureRandomBytes(length: number): Uint8Array {
  if (!Number.isInteger(length) || length < 0 || length > 65536)
    throw new Error('Invalid secure random byte count.');
  if (typeof globalThis.crypto?.getRandomValues !== 'function')
    throw new Error('Secure browser randomness is unavailable.');
  return globalThis.crypto.getRandomValues(new Uint8Array(length));
}
export function installNativeBuffer(): void {
  (globalThis as typeof globalThis & { Buffer?: typeof Buffer }).Buffer ??= Buffer;
}
export function installNativeCrypto(): void {
  installNativeBuffer();
  secureRandomBytes(0);
}
