import { haptic } from '../services/haptics';

/**
 * The haptic vocabulary (REDESIGN.md 3.6). Components name what happened, not
 * which motor to drive, so a feel is tuned in one place and a pattern such as
 * `incoming` means one thing everywhere.
 *
 * Reduce Motion never silences these; with fewer words on screen they carry
 * more of the meaning. Only Settings > Haptics turns them off.
 */
const pending = new Set<ReturnType<typeof setTimeout>>();

const later = (ms: number, play: () => void) => {
  const timer = setTimeout(() => {
    pending.delete(timer);
    play();
  }, ms);
  pending.add(timer);
  return timer;
};

/** How long after a held pattern's first warning its second plays. */
export const HELD_BEAT_MS = 300;

/** A held pattern's second warning, while it is still to play, and when. */
let heldBeat: { timer: ReturnType<typeof setTimeout>; at: number } | null =
  null;

/**
 * Drops the later beats of patterns still playing. For tests only, so a
 * pattern one test began is not felt in the next.
 */
export function forgetPendingHaptics() {
  pending.forEach(clearTimeout);
  pending.clear();
  heldBeat = null;
}

export const haptics = {
  /** Keys, chips, toggles and row taps. */
  tick: () => haptic('selection'),
  /** A primary control pressed in. */
  tap: () => haptic('light'),
  /** A hold completing, or a code detected. */
  thud: () => haptic('medium'),
  /** A key refused. */
  rigid: () => haptic('rigid'),
  /** Petal steps, a liquid settling, a pull crossing its threshold. */
  soft: () => haptic('soft'),
  success: () => haptic('success'),
  warning: () => haptic('warning'),
  error: () => haptic('error'),
  /** Money arrived, and nothing else: a success, then two light taps. */
  incoming: () => {
    haptic('success');
    later(120, () => haptic('light'));
    later(240, () => haptic('light'));
  },
  /** A payment held because its outcome is unknown: a warning, twice. */
  held: () => {
    haptic('warning');
    const timer = later(HELD_BEAT_MS, () => {
      heldBeat = null;
      haptic('warning');
    });
    heldBeat = { timer, at: Date.now() + HELD_BEAT_MS };
  },
  /**
   * A held payment seen to complete: a success, the news the held ring was
   * waiting for. A held pattern still playing gives its second warning up
   * to it, and the success plays at that beat, so no warning follows the
   * news and the two never crowd into one beat.
   */
  resolved: () => {
    const beat = heldBeat;
    if (!beat) {
      haptic('success');
      return;
    }
    heldBeat = null;
    clearTimeout(beat.timer);
    pending.delete(beat.timer);
    later(Math.max(0, beat.at - Date.now()), () => haptic('success'));
  },
  /**
   * Hold to send, called as each quarter of the hold is reached (1 to 4): a
   * tick for the first three and a thud when the hold completes.
   */
  holdRamp: (step: number) => haptic(step >= 4 ? 'medium' : 'selection'),
};
