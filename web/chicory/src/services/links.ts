import { useEffect } from 'react';
import { Linking } from 'react-native';

/**
 * `bitcoin:` and `lightning:` links handed to the app by another app, a browser
 * or a scanned code elsewhere on the phone.
 *
 * A link only ever *fills in* the send form. It never prepares or sends a
 * payment: the amount and fee still go through the same review the user has to
 * confirm, so an app that can open a URL cannot move money.
 *
 * Links that arrive before a wallet is open are dropped rather than queued.
 * Holding one across an unlock would mean acting on an intent from a moment the
 * user may not remember, and the sender can simply tap it again.
 */
const PAYMENT_SCHEME = /^(bitcoin|lightning):/i;

// The URL the app was launched with is one intent. Reading it again after a
// network switch or a wallet change would reopen Send with a request the user
// already dealt with, so it is consumed once per process.
let initialConsumed = false;

export function normalizePaymentLink(url: string | null | undefined) {
  if (!url) return '';
  const value = url.trim();
  if (!PAYMENT_SCHEME.test(value)) return '';
  // A bare `lightning:` prefix is not part of the invoice the parser reads.
  return value.replace(/^lightning:/i, '');
}

export function usePaymentLinks(ready: boolean, onRequest: (value: string) => void) {
  useEffect(() => {
    if (!ready) return;
    let active = true;
    const handle = (url: string | null | undefined) => {
      const request = normalizePaymentLink(url);
      if (active && request) onRequest(request);
    };
    if (!initialConsumed) {
      initialConsumed = true;
      Linking.getInitialURL().then(handle).catch(() => {});
    }
    const subscription = Linking.addEventListener('url', ({ url }) =>
      handle(url),
    );
    return () => {
      active = false;
      subscription.remove();
    };
  }, [ready, onRequest]);
}
