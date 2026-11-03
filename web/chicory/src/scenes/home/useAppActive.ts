import { useEffect, useState } from 'react';
import { AppState } from 'react-native';

/**
 * Whether the app is in front, so a loop nobody can see stops drawing. Under
 * Jest the state is unknown, which counts as in front.
 */
export function useAppActive(): boolean {
  const [active, setActive] = useState(
    () =>
      AppState.currentState !== 'background' &&
      AppState.currentState !== 'inactive',
  );
  useEffect(() => {
    const subscription = AppState.addEventListener('change', state =>
      setActive(state === 'active'),
    );
    return () => subscription.remove();
  }, []);
  return active;
}
