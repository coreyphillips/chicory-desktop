import type { BrowserKey } from './keyboard';

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
  /** The portable full backup, by passphrase only. */
  fullBackup?: import('./fullBackup').DesktopFullBackup;
  /** Erases every wallet in this profile. On success the host reloads into first-run setup. */
  erase?(): Promise<{ ok: boolean; code?: string; error?: string }>;
  onCommand(callback: (command: string, value?: string) => void): () => void;
}

declare global {
  interface Window { chicoryDesktop?: DesktopBridge }
}

/** The scenes that only show the open wallet, which its cached view can show while its engine starts. */
const VIEW_SCENES: readonly string[] = ['home', 'activity', 'settings'];

/**
 * Whether a native menu, shortcut, sidebar button or payment link may act
 * now. Each is dropped, never queued, while no wallet is ready, a wallet is
 * being chosen, opened or switched, a payment is under way or an overlay is
 * open, so a link can never land in a wallet other than the one on screen or
 * replace a payment in review. While the open wallet's engine is `starting`
 * behind its last view, Overview, Activity and Settings still open, so a
 * wallet that cannot connect can be looked at and reconfigured; Send,
 * Receive and links wait for it to answer.
 */
export function commandAccepted(
  state: { ready: boolean; choosing: boolean; busy: boolean; overlay: unknown; starting?: boolean },
  command?: string,
): boolean {
  if (!state.ready || state.choosing || state.busy || state.overlay) return false;
  return !state.starting || (command !== undefined && VIEW_SCENES.includes(command));
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
