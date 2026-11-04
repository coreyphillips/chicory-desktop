import type { HostReportInput } from './desktop';

/** The browser cannot count host process threads. Host diagnostics remain authoritative. */
export async function threadCount(): Promise<null> { return null; }

/**
 * The desktop host's redacted support report, which carries the wallet's own
 * figures once they are redacted by the host. Null outside the desktop app.
 */
export async function hostReport(input: HostReportInput): Promise<string | null> {
  const bridge = typeof window === 'undefined' ? undefined : window.chicoryDesktop;
  if (!bridge?.diagnostics) return null;
  try {
    const text = await bridge.diagnostics(input);
    return typeof text === 'string' ? text : null;
  } catch {
    return null;
  }
}
