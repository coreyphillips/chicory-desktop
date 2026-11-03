import * as Keychain from 'react-native-keychain';

export interface OfflineReceiveDraft {
  id: string;
  amountSats: number;
  description: string;
}
const PREFIX = 'com.beignet.wallet.offline-request.';
const serviceFor = (walletId: string) =>
  `${PREFIX}${encodeURIComponent(walletId)}`;

/** Save the identity before creating a reservation so an interrupted request can resume. */
export async function saveOfflineReceiveDraft(
  walletId: string,
  draft: OfflineReceiveDraft,
) {
  const result = await Keychain.setGenericPassword(
    'offline-request',
    JSON.stringify(draft),
    {
      service: serviceFor(walletId),
      accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    },
  );
  if (!result)
    throw Error(
      'The payment request could not be saved. Retry before creating it.',
    );
}
export async function loadOfflineReceiveDraft(
  walletId: string,
): Promise<OfflineReceiveDraft | null> {
  const saved = await Keychain.getGenericPassword({
    service: serviceFor(walletId),
  });
  if (!saved) return null;
  const draft = JSON.parse(saved.password) as OfflineReceiveDraft;
  if (
    !/^[a-zA-Z0-9_-]{16,160}$/.test(draft.id) ||
    !Number.isSafeInteger(draft.amountSats) ||
    draft.amountSats <= 0 ||
    typeof draft.description !== 'string'
  )
    throw Error(
      'The saved payment request could not be read. Check Activity before creating another.',
    );
  return draft;
}
export async function clearOfflineReceiveDraft(walletId: string) {
  await clearService(serviceFor(walletId));
}

async function clearService(service: string) {
  const removed = await Keychain.resetGenericPassword({ service });
  if (!removed && (await Keychain.getGenericPassword({ service })))
    throw Error(
      'The saved request could not be removed. Retry when secure storage is available.',
    );
}
export async function clearOfflineReceiveDrafts() {
  const services = await Keychain.getAllGenericPasswordServices();
  for (const service of services.filter(name => name.startsWith(PREFIX)))
    await clearService(service);
}
