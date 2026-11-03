import { AccessibilityInfo, Platform } from 'react-native';

/**
 * The one way the app speaks to a screen reader (REDESIGN.md 9).
 *
 * `assertive` is for the safety states: on iOS it interrupts whatever is being
 * read instead of queueing behind it. Android has a single announcement call,
 * so both kinds go through it there.
 *
 * A message already spoken within REPEAT_MS is dropped, even if others came
 * between. A poll or a re-render can report one state several times, and
 * hearing it again adds nothing.
 */
const REPEAT_MS = 2000;

const recent = new Map<string, number>();

export function announce(
  text: string,
  { assertive = false }: { assertive?: boolean } = {},
) {
  if (!text) return;
  const now = Date.now();
  for (const [said, at] of recent) {
    if (now - at >= REPEAT_MS) recent.delete(said);
  }
  if (recent.has(text)) return;
  recent.set(text, now);
  if (Platform.OS === 'ios') {
    AccessibilityInfo.announceForAccessibilityWithOptions(text, {
      queue: !assertive,
    });
  } else {
    AccessibilityInfo.announceForAccessibility(text);
  }
}

/**
 * Forgets what was said recently, so the next message is heard even if it
 * was said within REPEAT_MS. For tests only: each test can start with
 * nothing said rather than move the clock past the window.
 */
export function forgetSpoken() {
  recent.clear();
}
