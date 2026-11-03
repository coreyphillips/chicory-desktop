import { useEffect, useState } from 'react';
import { AccessibilityInfo } from 'react-native';

/**
 * Whether a screen reader is running, kept current as one is turned on or
 * off. Until the first answer it reads as off.
 */
export function useScreenReader(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    let active = true;
    AccessibilityInfo.isScreenReaderEnabled()
      .then(next => {
        if (active) setOn(next);
      })
      .catch(() => {});
    const subscription = AccessibilityInfo.addEventListener(
      'screenReaderChanged',
      next => {
        if (active) setOn(next);
      },
    );
    return () => {
      active = false;
      subscription.remove();
    };
  }, []);
  return on;
}
