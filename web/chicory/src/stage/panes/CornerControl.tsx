import React, { useCallback, useMemo, useRef } from 'react';
import { Pressable, StyleSheet } from 'react-native';
import Reanimated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import { Icon } from '../../components/ui';
import { copy } from '../../design/copy';
import type { GlyphName } from '../../design/glyphs';
import { haptics } from '../../design/haptics';
import { palette } from '../../design/palette';
import { TapTarget } from '../../glyphs/TapTarget';
import { spinIn, spinOut } from '../../motion/presets';
import { springs } from '../../motion/tokens';
import { useMotionPrefs } from '../../motion/useMotionPrefs';
import { space } from '../../theme';
import { useStage } from '../StageContext';
import { useCanvasPanes, usePaneActive } from './Pane';
import { moveCover } from './usePaneMotion';

/**
 * The corner control's touch target, the least any control gets
 * (REDESIGN.md 3.4), and the glyph drawn in the middle of it.
 */
export const CORNER_TARGET = 48;
const GLYPH = 20;

/**
 * How far the target reaches past the edge of the 40pt disc the corner
 * control drew before, on each side: the canvas hangs it this much nearer
 * the screen's edge, so its glyph stays where it always sat.
 */
export const CORNER_REACH = (CORNER_TARGET - 40) / 2;

/**
 * The room the canvas's corner control takes at the right of the status row,
 * its target and the gap before it, which the row leaves free.
 */
export const CORNER_ROOM = CORNER_TARGET + space.xxs;

/** How far the cog turns as Settings covers the canvas (REDESIGN.md 7, T6). */
export const COG_TURN = 120;

/**
 * The one control in the top right corner: Settings from home, and the way
 * back from everywhere else. It is disabled while a payment or a new wallet is
 * in flight, since back would abandon it. The canvas draws its own after Home,
 * at the top right, so a screen reader reaches it after the actions. Under
 * Settings the canvas's corner stays drawn but takes no touches; Settings has
 * its own.
 *
 * The cog spins out as the close spins in, and back (REDESIGN.md 7, T1), and
 * on the canvas the cog turns 120 degrees with Settings as it covers the
 * canvas, and back with it, the swipe that closes Settings included (T6).
 * Under Reduce Motion the two crossfade and the cog stays still.
 *
 * `scale` grows its target and glyph with the text, as Settings' close does
 * (`glyphScale`), drawn at that size rather than scaled up from 48pt.
 *
 * The cog answers on the UI thread (`CogButton`): as the tap lands, Settings'
 * cover starts there (`moveCover`), so the canvas recedes and the cog turns
 * even while the wallet engine holds the JavaScript thread as it opens.
 * Settings itself follows when the thread is free, and if the stage refuses
 * the tap, as it does while a pane is still moving, the cover goes back
 * (`realign`).
 */
export function CornerControl({
  home,
  scale = 1,
}: {
  home: boolean;
  scale?: number;
}) {
  const { state, actions, panes: motion } = useStage();
  const live = usePaneActive();
  const panes = useCanvasPanes();
  const { reduced } = useMotionPrefs();
  const paneCover = panes?.cover;
  const coverNow = useMemo(
    () =>
      paneCover
        ? () => {
            'worklet';
            moveCover(paneCover, 1, reduced);
          }
        : undefined,
    [paneCover, reduced],
  );
  // The tap was taken on the UI thread when the cog was live; by the time
  // the JavaScript thread hears of it, an overlay may have covered it, as a
  // Pressable would have known. Then it only puts the cover back.
  const liveNow = useRef(live);
  liveNow.current = live;
  const openSettings = useCallback(() => {
    if (liveNow.current) {
      haptics.tick();
      actions.openSettings();
    }
    motion.current?.realign();
  }, [actions, motion]);
  // Only the cog turns: Settings' own close comes in over it, upright.
  const turns = home && !reduced ? panes : null;
  const turn = useAnimatedStyle(() => {
    const cover = turns ? turns.cover.get() : 0;
    return { transform: [{ rotate: `${cover * COG_TURN}deg` }] };
  }, [turns]);
  return (
    <Reanimated.View style={turn}>
      <Reanimated.View
        key={home ? 'cog' : 'close'}
        entering={spinIn()}
        exiting={spinOut()}
      >
        {home ? (
          <CogButton
            scale={scale}
            onPress={live ? openSettings : undefined}
            onPressUi={coverNow}
          />
        ) : (
          <CornerButton
            glyph="close"
            label={copy.home.close}
            disabled={state.busy}
            scale={scale}
            onPress={live ? actions.back : undefined}
          />
        )}
      </Reanimated.View>
    </Reanimated.View>
  );
}

/**
 * The cog, which answers on the UI thread (`TapTarget`): `onPressUi`, a
 * worklet, runs as the tap lands, and `onPress` when the JavaScript thread
 * is free, which ticks only for a tap it takes. Drawn as CornerButton draws
 * it.
 */
function CogButton({
  scale,
  onPress,
  onPressUi,
}: {
  scale: number;
  onPress?: () => void;
  onPressUi?: () => void;
}) {
  return (
    <TapTarget
      accessibilityLabel={copy.home.settings}
      onPress={onPress}
      onPressUi={onPressUi}
      style={[
        styles.target,
        scale !== 1 && {
          width: CORNER_TARGET * scale,
          height: CORNER_TARGET * scale,
        },
      ]}
    >
      <Icon name="cog" size={GLYPH * scale} color={palette.cream} />
    </TapTarget>
  );
}

/**
 * A plain glyph in a 48pt target, both grown by `scale`, which dips as it is
 * pressed. Like the canvas's other controls, it takes no touches without an
 * `onPress`.
 */
function CornerButton({
  glyph,
  label,
  disabled = false,
  scale,
  onPress,
}: {
  glyph: GlyphName;
  label: string;
  disabled?: boolean;
  scale: number;
  onPress?: () => void;
}) {
  const { reduced } = useMotionPrefs();
  const press = useSharedValue(1);
  const style = useAnimatedStyle(() => ({
    transform: [{ scale: press.get() }],
  }));
  const to = (value: number) =>
    press.set(reduced ? 1 : withSpring(value, springs.snap));
  return (
    <Reanimated.View style={style}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ disabled }}
        disabled={disabled}
        onPressIn={onPress && (() => to(0.94))}
        onPressOut={onPress && (() => to(1))}
        onPress={
          onPress &&
          (() => {
            haptics.tick();
            onPress();
          })
        }
        style={[
          styles.target,
          scale !== 1 && {
            width: CORNER_TARGET * scale,
            height: CORNER_TARGET * scale,
          },
          disabled && styles.disabled,
        ]}
      >
        <Icon name={glyph} size={GLYPH * scale} color={palette.cream} />
      </Pressable>
    </Reanimated.View>
  );
}

const styles = StyleSheet.create({
  target: {
    width: CORNER_TARGET,
    height: CORNER_TARGET,
    alignItems: 'center',
    justifyContent: 'center',
  },
  disabled: { opacity: 0.45 },
});
