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
  readonly version: string;
  minimize(): void;
  toggleMaximize(): void;
  close(): void;
  /** The host's redacted support report, with the given wallet figures redacted into it. */
  diagnostics?(input: HostReportInput): Promise<string>;
  onCommand(callback: (command: string, value?: string) => void): () => void;
}

declare global {
  interface Window { chicoryDesktop?: DesktopBridge }
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
