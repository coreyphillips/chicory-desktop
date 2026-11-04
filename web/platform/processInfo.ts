import type { HostReportInput } from './desktop';

/** The browser cannot count host process threads. Host diagnostics remain authoritative. */
export async function threadCount(): Promise<null> { return null; }

/**
 * The desktop host's redacted support report, which carries the wallet's own
 * figures once they are redacted by the host. Null outside the desktop app.
 * It rejects rather than returning null when the host fails, so a caller
 * never shows the unredacted figures in its place.
 */
export async function hostReport(input: HostReportInput): Promise<string | null> {
  const bridge = typeof window === 'undefined' ? undefined : window.chicoryDesktop;
  if (!bridge?.diagnostics) return null;
  const text = await bridge.diagnostics(input);
  if (typeof text !== 'string') throw new Error('The desktop report could not be read.');
  return text;
}
