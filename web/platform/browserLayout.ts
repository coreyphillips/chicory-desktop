import { useSyncExternalStore } from 'react';

export const DESKTOP_MIN_WIDTH = 900;
export function desktopLayout(width: number) { return width >= DESKTOP_MIN_WIDTH; }
export function activityWidth(width: number, expanded = false) {
  // Keep payment forms comfortably readable even in a narrow desktop window.
  return Math.round(Math.min(Math.max(0, width - 420), expanded ? 520 : 420,
    Math.max(312, width * (expanded ? 0.46 : 0.34))));
}
const query = `(min-width: ${DESKTOP_MIN_WIDTH}px)`;
const subscribe = (changed: () => void) => {
  const media = window.matchMedia(query);
  media.addEventListener('change', changed);
  return () => media.removeEventListener('change', changed);
};
export function useDesktopLayout() {
  return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches, () => false);
}
