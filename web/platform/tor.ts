export type TorPhase = 'stopped' | 'starting' | 'ready' | 'failed';
export const TOR_SOCKS_HOST = '';
export const TOR_SOCKS_PORT = 0;
export function isOnionHost(host: string): boolean { return host.trim().toLowerCase().endsWith('.onion'); }
/** Tor belongs to the host service, with no browser daemon or proxy. */
export function torPhase(): TorPhase { return 'stopped'; }
export function torFailure(): string { return ''; }
export function torDataDirectory(): never { throw new Error('Tor is managed by the local wallet service.'); }
export async function ensureTorReady(): Promise<never> { throw new Error('Tor connections must be opened by the local wallet service.'); }
export async function stopTor(): Promise<never> { throw new Error('Tor is managed by the local wallet service.'); }
