import React, {
  PropsWithChildren,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { StyleSheet, View } from 'react-native';
import Reanimated, {
  ReduceMotion,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import type { EntryExitAnimationFunction } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { announce } from '../design/announce';
import { palette } from '../design/palette';
import { curves, durations, springs } from '../motion/tokens';
import { motionReduced } from '../services/motion';
import { space } from '../theme';
import { Icon } from './ui';
import type { IconName } from './ui';

/**
 * Transient confirmation for actions that leave no trace on screen: copying a
 * request, pasting one, linking an old one.
 *
 * There are no words on screen outside Settings (REDESIGN.md rule 1), so a
 * toast is a glyph that flashes near the bottom edge, a check when it went
 * well and a bang when it did not, while a screen reader hears the message.
 *
 * Deliberately not used for anything a user must act on. Errors and settings
 * outcomes stay in place next to the control that produced them, so a
 * message about money never disappears on a timer.
 */
type Tone = 'default' | 'success' | 'error';
type Toast = { id: number; tone: Tone; icon?: IconName };

const SHOWN_MS = 1400;
const DISC = 44;

const ToastContext = createContext<
  (message: string, tone?: Tone, icon?: IconName) => void
>(() => {});

export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children }: PropsWithChildren) {
  const [toast, setToast] = useState<Toast | null>(null);
  const counter = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const show = useCallback(
    (message: string, tone: Tone = 'default', icon?: IconName) => {
      announce(message, { assertive: tone === 'error' });
      counter.current += 1;
      setToast({ id: counter.current, tone, icon });
    },
    [],
  );

  useEffect(() => {
    if (!toast) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setToast(null), SHOWN_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [toast]);

  return (
    <ToastContext.Provider value={show}>
      {children}
      {toast ? <Flash key={toast.id} toast={toast} /> : null}
    </ToastContext.Provider>
  );
}

/**
 * The flash pops in on the reveal spring and fades out on the exit curve.
 * Under Reduce Motion it only fades, which Reanimated would otherwise drop.
 */
function flash(to: 0 | 1): EntryExitAnimationFunction {
  const pop = to === 1 && !motionReduced();
  return () => {
    'worklet';
    const fade = withTiming(to, {
      duration: to ? durations.crossfade : durations.exit,
      easing: to ? curves.standard : curves.exit,
      reduceMotion: ReduceMotion.Never,
    });
    if (!pop) {
      return {
        initialValues: { opacity: 1 - to },
        animations: { opacity: fade },
      };
    }
    return {
      initialValues: { opacity: 0, transform: [{ scale: 0.6 }] },
      animations: {
        opacity: fade,
        transform: [{ scale: withSpring(1, springs.reveal) }],
      },
    };
  };
}

function Flash({ toast }: { toast: Toast }) {
  const { bottom } = useSafeAreaInsets();
  const failed = toast.tone === 'error';
  return (
    <View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[styles.wrap, { bottom: bottom + space.xxxl + space.lg }]}
    >
      <Reanimated.View
        entering={flash(1)}
        exiting={flash(0)}
        style={[styles.disc, failed && styles.failed]}
      >
        <Icon
          name={
            failed
              ? 'bang'
              : toast.tone === 'success'
              ? 'check'
              : toast.icon ?? 'check'
          }
          size={22}
          color={
            failed
              ? palette.radish
              : toast.tone === 'success'
              ? palette.sage
              : palette.cream
          }
        />
      </Reanimated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
  disc: {
    width: DISC,
    height: DISC,
    borderRadius: DISC / 2,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: palette.cocoa,
  },
  failed: { backgroundColor: palette.radishSoft },
});
