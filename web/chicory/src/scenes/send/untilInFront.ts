import { AppState } from 'react-native';

/** The longest anything waits for the app to come back to the front. */
export const FRONT_WAIT_MS = 1500;

/**
 * Resolves once the app is in front again. A system prompt, such as the
 * paste permission, makes the app inactive while it is up, and the answer
 * to the call that raised it comes back before the prompt has gone: what
 * the answer brings, a refusal's cross and its haptic say, should land
 * where the person sees and feels it. It resolves at once while the app is
 * not inactive, and after `most` ms whatever happens, so a prompt that
 * never reports back holds nothing up.
 */
export function untilInFront(most = FRONT_WAIT_MS): Promise<void> {
  if (AppState.currentState !== 'inactive') return Promise.resolve();
  return new Promise(resolve => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const subscription = AppState.addEventListener('change', state => {
      if (state !== 'inactive') finish();
    });
    function finish() {
      clearTimeout(timer);
      subscription.remove();
      resolve();
    }
    timer = setTimeout(finish, most);
  });
}
