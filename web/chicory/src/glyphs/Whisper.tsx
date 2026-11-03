import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { PropsWithChildren } from 'react';
import { StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import type {
  HostInstance,
  LayoutChangeEvent,
  StyleProp,
  ViewInstance,
  ViewStyle,
} from 'react-native';
import {
  GestureDetector,
  useLongPressGesture,
} from 'react-native-gesture-handler';
import Reanimated, {
  FadeOut,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { haptics } from '../design/haptics';
import { palette } from '../design/palette';
import { curves, durations } from '../motion/tokens';
import { useMotionPrefs } from '../motion/useMotionPrefs';
import { usePaneActive } from '../stage/panes/Pane';
import { radius, space, type as typography } from '../theme';

/**
 * Whisper (REDESIGN.md rule 3): long-pressing a status glyph, ring or
 * disabled control for 400ms shows its accessibility string in a small cocoa
 * pill for 2.4 seconds. It is the only text a person can summon outside
 * Settings, and it is the same string a screen reader already hears, so the
 * pill itself is hidden from one.
 *
 * `WhisperProvider` draws the pill above everything, once, near the top of
 * the app, so only one whisper shows at a time. The pill sits just above
 * the element that was pressed, centred on it and kept inside the screen,
 * and grows in from .92 as it fades up. It goes with what it speaks for:
 * when that leaves the screen or its pane goes out of use, the pill goes
 * too. `Whisper` wraps what can be asked about; outside a provider it only
 * renders its children.
 *
 * `enabled` false keeps the wrapper and turns only the long press off, for
 * a control that whispers while it is disabled and not once it is enabled,
 * so it is not drawn again as it changes. `style` lays out the wrapper that
 * catches the press, such as filling a badge rather than only its glyph.
 */
const DELAY_MS = 400;
const SHOWN_MS = 2400;
/** Between the pill and what it speaks for. */
const GAP = space.xs;
/**
 * The pill never comes closer than this to the screen's edge: the page edge
 * (REDESIGN.md 3.4), where everything else on the page stops too.
 */
const EDGE = space.xl;

/** A rectangle in the window's coordinates. */
export interface Anchor {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Who asked for a whisper, so only they can take it back. */
type Owner = object;

interface Whispers {
  show: (label: string, source: Anchor, owner: Owner) => void;
  hide: (owner: Owner) => void;
}

const WhisperContext = createContext<Whispers | null>(null);

interface Shown {
  label: string;
  source: Anchor;
  owner: Owner;
  key: number;
}

/**
 * Where a pill `width` by `height` goes over `source` on a screen `bounds`
 * wide: centred above it, inside the edges, and below it instead when there
 * is no room above.
 */
export function pillPlace(
  source: Anchor,
  width: number,
  height: number,
  bounds: number,
) {
  'worklet';
  const centred = source.x + source.width / 2 - width / 2;
  const x = Math.min(
    Math.max(centred, EDGE),
    Math.max(EDGE, bounds - EDGE - width),
  );
  const above = source.y - GAP - height;
  const y = above >= EDGE ? above : source.y + source.height + GAP;
  return { x, y };
}

/**
 * Where `node` is in the window, read at once. A renderer without the DOM
 * layout API, such as the test renderer, gives nothing.
 */
function measure(node: HostInstance | null): Anchor | null {
  if (!node || typeof node.getBoundingClientRect !== 'function') return null;
  const { x, y, width, height } = node.getBoundingClientRect();
  return { x, y, width, height };
}

const PILL_OUT = FadeOut.duration(durations.exit).reduceMotion(
  ReduceMotion.Never,
);

function Pill({
  label,
  source,
  bounds,
}: {
  label: string;
  source: Anchor;
  bounds: number;
}) {
  const { reduced } = useMotionPrefs();
  const width = useSharedValue(0);
  const height = useSharedValue(0);
  const shown = useSharedValue(0);
  // Its size is known once it has laid out; until then it is placed but
  // unseen, so it never appears somewhere and then jumps.
  const onLayout = useCallback(
    (event: LayoutChangeEvent) => {
      width.set(event.nativeEvent.layout.width);
      height.set(event.nativeEvent.layout.height);
      shown.set(
        withTiming(1, {
          duration: durations.crossfade,
          easing: curves.enter,
          reduceMotion: ReduceMotion.Never,
        }),
      );
    },
    [width, height, shown],
  );
  const style = useAnimatedStyle(() => {
    const at = pillPlace(source, width.get(), height.get(), bounds);
    const grown = reduced ? 1 : 0.92 + 0.08 * shown.get();
    return {
      opacity: shown.get(),
      transform: [{ translateX: at.x }, { translateY: at.y }, { scale: grown }],
    };
  }, [source, bounds, reduced]);
  return (
    <Reanimated.View
      exiting={PILL_OUT}
      onLayout={onLayout}
      style={[styles.pill, { maxWidth: bounds - 2 * EDGE }, style]}
    >
      {/* Balanced lines, so a short last word is never left alone on its
          own line. */}
      <Text
        style={styles.text}
        lineBreakStrategyIOS="standard"
        textBreakStrategy="balanced"
      >
        {label}
      </Text>
    </Reanimated.View>
  );
}

export function WhisperProvider({ children }: PropsWithChildren) {
  const [shown, setShown] = useState<Shown | null>(null);
  const root = useRef<ViewInstance>(null);
  const { width: windowWidth } = useWindowDimensions();
  const [bounds, setBounds] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const show = useCallback<Whispers['show']>((label, source, owner) => {
    haptics.tick();
    clearTimeout(timer.current);
    // The pill is drawn in this root, which need not start at the window's
    // corner, so the source is moved into its coordinates.
    const origin = measure(root.current);
    const local = origin
      ? { ...source, x: source.x - origin.x, y: source.y - origin.y }
      : source;
    setShown(last => ({
      label,
      source: local,
      owner,
      key: (last?.key ?? 0) + 1,
    }));
    timer.current = setTimeout(() => setShown(null), SHOWN_MS);
  }, []);
  const hide = useCallback<Whispers['hide']>(
    owner => setShown(last => (last?.owner === owner ? null : last)),
    [],
  );
  const whispers = useMemo(() => ({ show, hide }), [show, hide]);
  useEffect(() => () => clearTimeout(timer.current), []);
  const onLayout = useCallback(
    (event: LayoutChangeEvent) => setBounds(event.nativeEvent.layout.width),
    [],
  );
  return (
    <WhisperContext.Provider value={whispers}>
      <View ref={root} style={styles.root} onLayout={onLayout}>
        {children}
        {shown ? (
          <View
            style={StyleSheet.absoluteFill}
            pointerEvents="none"
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
          >
            <Pill
              key={shown.key}
              label={shown.label}
              source={shown.source}
              bounds={bounds || windowWidth}
            />
          </View>
        ) : null}
      </View>
    </WhisperContext.Provider>
  );
}

interface WhisperProps {
  label: string;
  enabled?: boolean;
  style?: StyleProp<ViewStyle>;
}

/** A long press on `children` whispers `label` above them. */
function Heard({
  label,
  enabled = true,
  style,
  whispers,
  children,
}: PropsWithChildren<WhisperProps & { whispers: Whispers }>) {
  const source = useRef<ViewInstance>(null);
  // This whisper's own identity, kept for its lifetime.
  const [owner] = useState<Owner>(() => ({}));
  const active = usePaneActive() && enabled;
  const { show, hide } = whispers;
  useEffect(() => {
    if (!active) hide(owner);
  }, [active, hide, owner]);
  useEffect(() => () => hide(owner), [hide, owner]);
  const hold = useLongPressGesture({
    minDuration: DELAY_MS,
    runOnJS: true,
    enabled: active,
    onActivate: event =>
      show(
        label,
        measure(source.current) ?? {
          x: event.absoluteX || 0,
          y: event.absoluteY || 0,
          width: 0,
          height: 0,
        },
        owner,
      ),
  });
  return (
    <GestureDetector gesture={hold}>
      <View ref={source} collapsable={false} style={style}>
        {children}
      </View>
    </GestureDetector>
  );
}

export function Whisper({
  children,
  ...props
}: PropsWithChildren<WhisperProps>) {
  const whispers = useContext(WhisperContext);
  if (!whispers) return <>{children}</>;
  return (
    <Heard {...props} whispers={whispers}>
      {children}
    </Heard>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  pill: {
    position: 'absolute',
    left: 0,
    top: 0,
    paddingHorizontal: space.sm,
    paddingVertical: space.xs,
    borderRadius: radius.round,
    backgroundColor: palette.cocoa,
  },
  text: { ...typography.whisper, color: palette.cream },
});
