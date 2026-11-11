import { useCallback, useEffect, useRef, useState } from 'react';
import type { SetStateAction } from 'react';
import * as Keychain from 'react-native-keychain';

const SERVICE = 'com.beignet.wallet.balance-visibility';
let lastWrite = Promise.resolve();

async function readHidden(): Promise<boolean> {
  await lastWrite;
  try {
    const entry = await Keychain.getGenericPassword({ service: SERVICE });
    // Only a confirmed absence or an explicit reveal may expose figures.
    return entry !== false && entry?.password !== 'visible';
  } catch {
    return true;
  }
}

function saveHidden(hidden: boolean) {
  // A slow hide must finish before a later reveal, even across a remount.
  lastWrite = lastWrite.then(async () => {
    try {
      await Keychain.setGenericPassword(
        'balance-visibility',
        hidden ? 'hidden' : 'visible',
        {
          service: SERVICE,
          accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
        },
      );
    } catch {
      // Keep the explicit choice in this session. Later writes can still run.
    }
  });
}

/** Mask the first wallet frame while the device-local choice is loading. */
export function useBalanceVisibility() {
  const [hidden, showMask] = useState(true);
  const choice = useRef<boolean | null>(null);

  useEffect(() => {
    let active = true;
    readHidden().then(saved => {
      if (active && choice.current === null) showMask(saved);
    });
    return () => {
      active = false;
    };
  }, []);

  const setHidden = useCallback(
    (action: SetStateAction<boolean>) => {
      const next =
        typeof action === 'function'
          ? action(choice.current ?? hidden)
          : action;
      choice.current = next;
      showMask(next);
      saveHidden(next);
    },
    [hidden],
  );
  return [hidden, setHidden] as const;
}
