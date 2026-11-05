import type { BrowserKey } from './keyboard';
import type { Network } from '@beignet/wallet-core';

export interface FlorestaState {
  requested: boolean;
  storage: string;
  customStorage: boolean;
  phase: 'stopped' | 'starting' | 'running' | 'restarting' | 'failed';
  height: number | null;
  validatedHeight: number | null;
  tipSynced: boolean | null;
  watches: { observedWallets: number; confirmedScansCaughtUp: number } | { unavailable: true } | null;
  error: string | null;
}

export type FlorestaSettingsBridge = Record<'status' | 'start' | 'stop' | 'folder', (network: Network) => Promise<FlorestaState>>;

export type DesktopScene = 'home' | 'send' | 'receive' | 'activity' | 'settings';
export type DesktopCommand = DesktopScene | 'payment-link';

export interface HostReportInput {
  wallet: unknown;
  walletError?: string;
  events: unknown[];
}

export interface DesktopBridge {
  readonly platform: string;
  minimize(): void;
  toggleMaximize(): void;
  close(): void;
  /** The host's redacted support report, with the given wallet figures redacted into it. */
  diagnostics?(input: HostReportInput): Promise<string>;
  floresta?: FlorestaSettingsBridge;
  /** The portable full backup, by passphrase only. */
  fullBackup?: import('./fullBackup').DesktopFullBackup;
  /** Erases every wallet in this profile. On success the host reloads into first-run setup. */
  erase?(): Promise<{ ok: boolean; code?: string; error?: string }>;
  onCommand(callback: (command: string, value?: string) => void): () => void;
}

declare global {
  interface Window { chicoryDesktop?: DesktopBridge }
}

/**
 * Whether a native menu, shortcut or payment link may act now. Each is
 * dropped, never queued, while no wallet is ready, a wallet is being chosen,
 * opened or switched, a payment is under way or an overlay is open, so a link
 * can never land in a wallet other than the one on screen or replace a
 * payment in review.
 */
export function commandAccepted(state: { ready: boolean; choosing: boolean; busy: boolean; overlay: unknown }): boolean {
  return state.ready && !state.choosing && !state.busy && !state.overlay;
}

export function desktopScene(command: string): DesktopScene | null {
  return ['home', 'send', 'receive', 'activity', 'settings'].includes(command)
    ? command as DesktopScene : null;
}

/** Navigation is deliberate and never claims typing, repeat or composition. */
export function desktopShortcut(event: BrowserKey): DesktopScene | null {
  if (event.repeat || event.isComposing || event.altKey || event.shiftKey ||
      (!event.metaKey && !event.ctrlKey)) return null;
  const shortcuts: Record<string, DesktopScene> = {
    '1': 'home', '2': 'send', '3': 'receive', '4': 'activity', ',': 'settings',
  };
  return shortcuts[event.key] ?? null;
}
