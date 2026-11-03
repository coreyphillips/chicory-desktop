import React, { useEffect, useState } from 'react';
import type { PropsWithChildren, Ref } from 'react';
import { AppState, Pressable, StyleSheet, View } from 'react-native';
import type { HostInstance, StyleProp, ViewStyle } from 'react-native';
import Reanimated, {
  cancelAnimation,
  LayoutAnimationConfig,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import type { EntryExitAnimationFunction } from 'react-native-reanimated';
import { Glyph } from '../../design/glyphs';
import type { GlyphName } from '../../design/glyphs';
import { haptics } from '../../design/haptics';
import { palette } from '../../design/palette';
import type { BloomTone } from '../../glyphs/Bloom';
import { Whisper } from '../../glyphs/Whisper';
import { riseIn, sceneOut } from '../../motion/presets';
import { curves, durations, overlap, springs } from '../../motion/tokens';
import { useMotionPrefs } from '../../motion/useMotionPrefs';
import { motionReduced } from '../../services/motion';
import { errorMessage } from '../../services/useWalletSession';
import { SETTINGS_SURFACE, SettingsNetwork } from '../settings/ui';
import { HIT_SLOP, radius, space } from '../../theme';

/**
 * What the shell phases share: the root each one enters and leaves through,
 * the round glyph controls that replaced their worded buttons, the pips that
 * carry an error, and the panel their setup surfaces open in.
 */

/** Whether the app is in the foreground, so a loop can rest while unseen. */
export function useAwake(): boolean {
  const [awake, setAwake] = useState(AppState.currentState !== 'background');
  useEffect(() => {
    const subscription = AppState.addEventListener('change', state =>
      setAwake(state !== 'background'),
    );
    return () => subscription.remove();
  }, []);
  return awake;
}

/**
 * Whether a loop that should run while `on` may run now: the app is in the
 * foreground and motion is wanted. Under Reduce Motion a loop becomes a still
 * state (REDESIGN.md 8), which each caller draws.
 */
export function useRunning(on: boolean): boolean {
  const awake = useAwake();
  const { reduced } = useMotionPrefs();
  return on && awake && !reduced;
}

/**
 * Ends an open or a choice the person asked for: a failure is felt as a
 * refusal, an error haptic, and its reason goes to `report`, which puts it
 * where the phase shows it. Failures the app meets on its own stay quiet;
 * the pip holding the reason is enough for those.
 */
export function refused(report?: (reason: string) => void) {
  return (e: unknown) => {
    haptics.error();
    report?.(errorMessage(e));
  };
}

/**
 * A phase's root. The outgoing phase fades and settles back while this one
 * rises in 80ms later, so one phase blends into the next rather than cutting.
 * A wait can arrive later still, so one that ends quickly never shows.
 */
export function PhaseRoot({
  children,
  style,
  delay = overlap.enterDelay,
}: PropsWithChildren<{ style?: StyleProp<ViewStyle>; delay?: number }>) {
  return (
    <Reanimated.View
      entering={riseIn(overlap.rise, delay)}
      exiting={sceneOut()}
      style={[styles.root, style]}
    >
      {children}
    </Reanimated.View>
  );
}

/** A glyph arriving in a control that swaps glyphs: a quarter turn in. */
function glyphIn(): EntryExitAnimationFunction {
  const reduced = motionReduced();
  return () => {
    'worklet';
    const config = {
      duration: reduced ? durations.crossfade : durations.enter,
      easing: reduced ? curves.standard : curves.enter,
      reduceMotion: ReduceMotion.Never,
    };
    return {
      initialValues: {
        opacity: 0,
        transform: [{ rotate: reduced ? '0deg' : '-90deg' }],
      },
      animations: {
        opacity: withTiming(1, config),
        transform: [{ rotate: withTiming('0deg', config) }],
      },
    };
  };
}

function glyphOut(): EntryExitAnimationFunction {
  return () => {
    'worklet';
    const config = {
      duration: durations.exit,
      easing: curves.exit,
      reduceMotion: ReduceMotion.Never,
    };
    return {
      initialValues: { opacity: 1 },
      animations: { opacity: withTiming(0, config) },
    };
  };
}

export type ControlLook = 'fill' | 'outline' | 'plain';

export interface Pip {
  tone: 'honey' | 'radish';
  /** What the pip means, for the Whisper pill and a screen reader. */
  label: string;
}

const PIP = { honey: palette.honey, radish: palette.radish };

/**
 * A round glyph control (REDESIGN.md 9): a role, a label, and its disabled
 * and busy state, with the words the old button showed moved into those.
 * `fill` is the primary, drawn in the network's tone; `outline` a secondary;
 * `plain` a quiet glyph such as the cog.
 *
 * While `busy` the glyph turns, a refresh at 900ms a turn. A pip at its upper
 * right carries something to know, such as a setup that failed. A long press
 * whispers what the pip means, or else what the control does, which is what
 * a glyph that has no word beside it owes a sighted user too. Like the
 * canvas's controls, it takes no touches without an `onPress`.
 */
export function GlyphButton({
  ref,
  glyph,
  label,
  hint,
  value,
  size,
  look = 'plain',
  tone = 'live',
  onPress,
  disabled = false,
  busy = false,
  pip,
}: {
  /** The control itself, for a phase that moves focus to it on arrival. */
  ref?: Ref<HostInstance>;
  glyph: GlyphName;
  label: string;
  hint?: string;
  /** Spoken after the label: what the pip says, or a state the glyph shows. */
  value?: string;
  size: number;
  look?: ControlLook;
  tone?: BloomTone;
  onPress?: () => void;
  disabled?: boolean;
  busy?: boolean;
  pip?: Pip | null;
}) {
  const inactive = disabled || busy;
  const press = useSharedValue(1);
  const pressStyle = useAnimatedStyle(() => ({
    transform: [{ scale: press.get() }],
  }));
  const turn = useSharedValue(0);
  const turnStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${turn.get() * 360}deg` }],
  }));
  const spinning = useRunning(busy);
  useEffect(() => {
    if (!spinning) return;
    turn.set(0);
    turn.set(
      withRepeat(
        withTiming(1, { duration: SPIN_MS, easing: curves.linear }),
        -1,
      ),
    );
    return () => {
      // The turn finishes rather than snapping back, so the glyph comes to
      // rest upright.
      cancelAnimation(turn);
      turn.set(
        withTiming(1, { duration: durations.move }, done => {
          'worklet';
          if (done) turn.set(0);
        }),
      );
    };
  }, [spinning, turn]);
  // Unmounting stops the finishing turn the cleanup above just started.
  useEffect(() => () => cancelAnimation(turn), [turn]);

  const fill = look === 'fill';
  const ink = inactive
    ? palette.dust
    : fill
    ? palette.ink
    : look === 'outline'
    ? palette.cream
    : palette.steam;
  const glyphSize = Math.round(size * (look === 'plain' ? 0.55 : 0.42));
  const disc: ViewStyle = { width: size, height: size, borderRadius: size / 2 };
  // The pill names the glyph, or says what its pip means. The wrapper is
  // always there, so a control that turns busy keeps its turn going.
  return (
    <Whisper label={pip?.label ?? label}>
      <Reanimated.View style={pressStyle}>
        <Pressable
          ref={ref}
          accessibilityRole="button"
          accessibilityLabel={label}
          accessibilityHint={hint}
          accessibilityValue={value ? { text: value } : undefined}
          accessibilityState={{ disabled: inactive, busy }}
          disabled={inactive}
          hitSlop={size < 48 ? HIT_SLOP : undefined}
          onPressIn={
            onPress && (() => press.set(withSpring(0.94, springs.snap)))
          }
          onPressOut={onPress && (() => press.set(withSpring(1, springs.snap)))}
          onPress={
            onPress &&
            (() => {
              if (fill) haptics.tap();
              else haptics.tick();
              onPress();
            })
          }
          style={[
            styles.disc,
            disc,
            fill && {
              backgroundColor: inactive
                ? palette.husk
                : tone === 'test'
                ? palette.slate
                : palette.bloom,
            },
            look === 'outline' && styles.outline,
          ]}
        >
          <LayoutAnimationConfig skipEntering>
            <Reanimated.View
              key={glyph}
              entering={glyphIn()}
              exiting={glyphOut()}
              style={turnStyle}
            >
              <Glyph name={glyph} size={glyphSize} color={ink} />
            </Reanimated.View>
          </LayoutAnimationConfig>
          {pip ? (
            <View style={[styles.pip, { backgroundColor: PIP[pip.tone] }]} />
          ) : null}
        </Pressable>
      </Reanimated.View>
    </Whisper>
  );
}

/** A busy refresh turns once in this long, over and over. */
const SPIN_MS = 900;

/**
 * A small dot that carries a message the phase used to write out: radish for
 * an error, honey for something to attend to. Hollow is the canvas's refresh
 * failed look. The words go to a screen reader, which hears an error as an
 * alert, and to the Whisper pill.
 */
export function StatusPip({
  tone,
  label,
  hollow = false,
}: Pip & { hollow?: boolean }) {
  return (
    <Whisper label={label}>
      <Reanimated.View
        entering={riseIn(0)}
        exiting={sceneOut()}
        accessible
        accessibilityRole={tone === 'radish' ? 'alert' : 'text'}
        accessibilityLabel={label}
        accessibilityLiveRegion="polite"
        style={styles.target}
      >
        <View
          style={[
            styles.status,
            hollow
              ? [styles.hollow, { borderColor: PIP[tone] }]
              : { backgroundColor: PIP[tone] },
          ]}
        />
      </Reanimated.View>
    </Whisper>
  );
}

/**
 * A setup surface opened from a phase: the network editor, the device's
 * connection, the recovery phrase. These are Settings-class (REDESIGN.md rule
 * 2), drawn in the Settings language and allowed their words, so the panel
 * carries the copy guard's marker for settings-class surfaces. A phase opens
 * at most one, and never while the Settings scene is drawn, so the marker
 * stays single. Nor does it draw one under the new wallet sheet, a surface
 * of its own that slides over the phase: the picker closes its network
 * editor as it opens the sheet, and draws none under a sheet opened any
 * other way (REDESIGN.md 10.1). The stage draws a new wallet's recovery
 * phrase (BackupPanel) in place of the phase, never beside a panel.
 */
export function SetupPanel({
  network,
  children,
}: PropsWithChildren<{
  /**
   * The network the setup is for, the active profile's or the wallet's: on
   * a test network the panel draws slate where it would draw bloom, as
   * Settings does (`SettingsNetwork`). Without one it keeps bloom.
   */
  network?: string;
}>) {
  return (
    <Reanimated.View
      testID={SETTINGS_SURFACE}
      entering={riseIn()}
      exiting={sceneOut()}
      style={styles.panel}
    >
      {network ? (
        <SettingsNetwork network={network}>{children}</SettingsNetwork>
      ) : (
        children
      )}
    </Reanimated.View>
  );
}

/** A name that is data: set small and quiet, the way the status row sets it. */
export const nameStyle = {
  fontSize: 17,
  lineHeight: 22,
  fontWeight: '500',
  color: palette.cream,
  textAlign: 'center',
} as const;

const STATUS_SIZE = 10;

const styles = StyleSheet.create({
  root: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.xl,
  },
  disc: { alignItems: 'center', justifyContent: 'center' },
  outline: { borderWidth: 1.5, borderColor: palette.bark },
  pip: {
    position: 'absolute',
    top: 2,
    right: 2,
    width: STATUS_SIZE,
    height: STATUS_SIZE,
    borderRadius: STATUS_SIZE / 2,
    borderWidth: 2,
    borderColor: palette.roast,
  },
  // Room around the dot for a finger to find it and hold it.
  target: {
    width: 24,
    height: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  status: {
    width: STATUS_SIZE,
    height: STATUS_SIZE,
    borderRadius: STATUS_SIZE / 2,
  },
  hollow: { borderWidth: 1.5 },
  panel: {
    alignSelf: 'stretch',
    gap: space.lg,
    padding: space.lg,
    borderRadius: radius.pane,
    backgroundColor: palette.espresso,
  },
});
