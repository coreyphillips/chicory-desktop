import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { authenticate, isLockEnabled, onLockChanged } from './lock';

/**
 * The app-open gate for the optional biometric / passcode lock.
 *
 * Enabling the lock in Settings used to do nothing on launch: the only thing
 * that ever asked for it was the recovery-phrase reveal. This is the gate that
 * makes the setting mean what it says.
 *
 * It holds the wallet session back rather than merely covering it: while
 * `locked` is true the session does not restore, so no engine is started and no
 * balance is read for someone who has not authenticated.
 *
 * Re-locking on return from the background is deliberately given a short grace
 * period. Sending a payment routinely bounces through the share sheet, the
 * camera permission dialog or a password manager, and prompting on every one of
 * those trains people to authenticate without reading, which is how a prompt
 * stops being a check at all.
 */
const BACKGROUND_GRACE_MS = 30000;

export function useAppLock() {
  // `checking` keeps the first frame from flashing either the wallet or the
  // lock screen before we know which is right.
  const [checking, setChecking] = useState(true);
  const [locked, setLocked] = useState(false);
  const [prompting, setPrompting] = useState(false);
  const [error, setError] = useState('');
  const enabled = useRef(false);
  const backgroundedAt = useRef<number | null>(null);
  const mounted = useRef(true);

  const prompt = useCallback(async () => {
    if (!enabled.current) {
      setLocked(false);
      return true;
    }
    setPrompting(true);
    setError('');
    try {
      const allowed = await authenticate('Unlock Chicory');
      if (!mounted.current) return allowed;
      if (allowed) {
        setLocked(false);
        backgroundedAt.current = null;
      } else {
        setError('Chicory stays locked until this is confirmed.');
      }
      return allowed;
    } finally {
      if (mounted.current) setPrompting(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    let active = true;
    isLockEnabled()
      .then(on => {
        if (!active) return;
        enabled.current = on;
        setLocked(on);
        setChecking(false);
        if (on) prompt();
      })
      .catch(() => {
        // A lock we cannot read is not a lock we should enforce: failing closed
        // here would strand someone out of their own wallet.
        if (active) {
          enabled.current = false;
          setLocked(false);
          setChecking(false);
        }
      });
    return () => {
      active = false;
      mounted.current = false;
    };
  }, [prompt]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => {
      if (!enabled.current) return;
      if (state === 'background' || state === 'inactive') {
        if (backgroundedAt.current === null) backgroundedAt.current = Date.now();
        return;
      }
      if (state !== 'active') return;
      const since = backgroundedAt.current;
      backgroundedAt.current = null;
      if (since !== null && Date.now() - since > BACKGROUND_GRACE_MS) {
        setLocked(true);
        prompt();
      }
    });
    return () => subscription.remove();
  }, [prompt]);

  /** Called when the user turns the lock on or off, so the gate stays in step. */
  const setEnabled = useCallback((value: boolean) => {
    enabled.current = value;
    if (!value) {
      setLocked(false);
      backgroundedAt.current = null;
    }
  }, []);

  // Settings saves the preference; the gate hears about it here, so turning
  // the lock on protects the very next background rather than the next launch.
  useEffect(() => onLockChanged(setEnabled), [setEnabled]);

  return { checking, locked, prompting, error, prompt, setEnabled };
}
