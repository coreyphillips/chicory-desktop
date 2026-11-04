/**
 * The gallery's secure store, aliased over react-native-keychain by
 * vite.gallery.config.ts. It remembers for the life of the page only, so a
 * gallery run never reads a production profile's preferences or leaves any.
 */
type Options = { service?: string } | undefined;
type Entry = { username: string; password: string };

const entries = new Map<string, Entry>();
const serviceOf = (options: Options) => options?.service ?? 'default';
let biometry: string | null = null;

export const ACCESSIBLE = Object.freeze({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'gallery' });
export const ACCESS_CONTROL = Object.freeze({ BIOMETRY_CURRENT_SET_OR_DEVICE_PASSCODE: 'gallery' });

export function forget(service: string) {
  entries.delete(service);
}

export function setSupportedBiometry(kind: string | null) {
  biometry = kind;
}

export async function getGenericPassword(options?: Options) {
  const service = serviceOf(options);
  const entry = entries.get(service);
  return entry ? { service, storage: 'gallery', ...entry } : false;
}

export async function setGenericPassword(username: string, password: string, options?: Options) {
  const service = serviceOf(options);
  entries.set(service, { username, password });
  return { service, storage: 'gallery' };
}

export async function hasGenericPassword(options?: Options) {
  return entries.has(serviceOf(options));
}

export async function resetGenericPassword(options?: Options) {
  entries.delete(serviceOf(options));
  return true as const;
}

export async function getAllGenericPasswordServices() {
  return [...entries.keys()];
}

export async function getSupportedBiometryType() {
  return biometry;
}
