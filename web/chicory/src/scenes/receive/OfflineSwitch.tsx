import React, { useEffect } from 'react';
import { Pressable, StyleSheet } from 'react-native';
import Reanimated, {
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import Svg, { Path } from 'react-native-svg';
import { copy } from '../../design/copy';
import { GLYPHS, strokeFor } from '../../design/glyphs';
import { haptics } from '../../design/haptics';
import { palette } from '../../design/palette';
import { useOnce, useShake } from '../../motion/effects';
import { springs } from '../../motion/tokens';
import { useMotionPrefs } from '../../motion/useMotionPrefs';
import { usePaneActive } from '../../stage/panes/Pane';
import { useBloom } from './tone';

const TRACK = { width: 60, height: 36 };
const KNOB = 28;
const INSET = (TRACK.height - KNOB) / 2;
const TRAVEL = TRACK.width - KNOB - INSET * 2;
const MOON = 18;

/**
 * Receiving offline, as a switch with the moon for its knob (REDESIGN.md 6,
 * Receive): off it is an outline on husk, and on it slides across and the
 * moon fills. A screen reader hears a switch with its state, and in its hint
 * what an offline receive is and what it can take.
 *
 * A new `shake` is the engine refusing an offline receive: the switch shakes
 * as its moon slides off (REDESIGN.md 6, RECEIVE_UNAVAILABLE).
 */
export function OfflineSwitch({
  on,
  cap,
  disabled,
  shake,
  onToggle,
}: {
  on: boolean;
  cap?: number;
  disabled: boolean;
  shake?: number;
  onToggle: (next: boolean) => void;
}) {
  const live = usePaneActive();
  const { reduced } = useMotionPrefs();
  const tones = useBloom();
  const refusal = useShake();
  useOnce(shake, refusal.play);
  const slide = useSharedValue(on ? 1 : 0);
  useEffect(() => {
    slide.set(reduced ? (on ? 1 : 0) : withSpring(on ? 1 : 0, springs.snap));
    return () => cancelAnimation(slide);
  }, [on, reduced, slide]);
  const knob = useAnimatedStyle(() => ({
    transform: [{ translateX: TRAVEL * slide.get() }],
  }));
  return (
    <Reanimated.View style={refusal.style}>
      <Pressable
        accessibilityRole="switch"
        accessibilityLabel={copy.receive.offline}
        accessibilityHint={
          on ? copy.receive.offlineOnHint(cap) : copy.receive.offlineOffHint
        }
        accessibilityState={{ checked: on, disabled }}
        disabled={disabled}
        hitSlop={6}
        onPress={
          live
            ? () => {
                haptics.tick();
                onToggle(!on);
              }
            : undefined
        }
        style={[
          styles.track,
          on && { backgroundColor: tones.night },
          disabled && styles.disabled,
        ]}
      >
        <Reanimated.View
          pointerEvents="none"
          style={[styles.tint, refusal.tint]}
        />
        <Reanimated.View
          style={[styles.knob, on && { backgroundColor: tones.bloom }, knob]}
        >
          <Svg
            width={MOON}
            height={MOON}
            viewBox="0 0 24 24"
            stroke={on ? palette.ink : palette.steam}
            strokeWidth={strokeFor(MOON)}
            strokeLinejoin="round"
          >
            <Path d={GLYPHS.moon[0].d} fill={on ? palette.ink : 'none'} />
          </Svg>
        </Reanimated.View>
      </Pressable>
    </Reanimated.View>
  );
}

const styles = StyleSheet.create({
  track: {
    ...TRACK,
    borderRadius: TRACK.height / 2,
    backgroundColor: palette.husk,
    padding: INSET,
  },
  disabled: { opacity: 0.5 },
  tint: {
    ...StyleSheet.absoluteFill,
    borderRadius: TRACK.height / 2,
    backgroundColor: palette.radishSoft,
  },
  knob: {
    width: KNOB,
    height: KNOB,
    borderRadius: KNOB / 2,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: palette.mocha,
  },
});
