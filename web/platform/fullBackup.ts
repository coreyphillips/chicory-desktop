/**
 * The portable full backup, through the desktop main process. The page only
 * supplies the passphrase: the main process asks the owner where to save or
 * which file to restore, and moves the encrypted archive itself, so the
 * archive never passes through the page. In a plain browser there is none.
 */
export interface FullBackupResult {
  ok: boolean;
  cancelled?: boolean;
  code?: string;
  error?: string;
  file?: string;
  restored?: Array<{ id: string; name: string; network: string }>;
  failed?: Array<{ id: string; name: string; code: string; message: string }>;
  skipped?: Array<{ id: string; name: string }>;
}
export interface DesktopFullBackup {
  export(passphrase: string): Promise<FullBackupResult>;
  restore(passphrase: string): Promise<FullBackupResult>;
}

/** The minimum a full backup passphrase must have, matching the wallet service. */
export const FULL_BACKUP_MIN_PASSPHRASE = 12;

function bridge(): DesktopFullBackup | undefined {
  return typeof window === 'undefined' ? undefined
    : (window as { chicoryDesktop?: { fullBackup?: DesktopFullBackup } }).chicoryDesktop?.fullBackup;
}

export function fullBackupAvailable(): boolean {
  return !!bridge();
}

function refusal(result: FullBackupResult | undefined, fallback: string): Error {
  return Object.assign(new Error(result?.error || fallback), { code: result?.code || 'FULL_BACKUP_FAILED' });
}

/** Saves a full backup to a file the owner picks. Null when they cancel. */
export async function exportFullBackup(passphrase: string): Promise<{ file: string } | null> {
  const backup = bridge();
  if (!backup) throw refusal(undefined, 'A full backup is only available in the desktop app.');
  const result = await backup.export(passphrase);
  if (result?.cancelled) return null;
  if (!result?.ok || !result.file) throw refusal(result, 'The full backup could not be saved.');
  return { file: result.file };
}

/** Restores a full backup from a file the owner picks. Null when they cancel. */
export async function restoreFullBackup(passphrase: string): Promise<Required<Pick<FullBackupResult, 'restored' | 'failed' | 'skipped'>> | null> {
  const backup = bridge();
  if (!backup) throw refusal(undefined, 'A full backup is only available in the desktop app.');
  const result = await backup.restore(passphrase);
  if (result?.cancelled) return null;
  if (!result?.ok) throw refusal(result, 'The full backup could not be restored.');
  return { restored: result.restored ?? [], failed: result.failed ?? [], skipped: result.skipped ?? [] };
}
