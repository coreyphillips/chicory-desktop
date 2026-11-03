import React, { memo, useEffect, useId, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Reanimated from 'react-native-reanimated';
import Svg, { Defs, RadialGradient, Rect, Stop } from 'react-native-svg';
import { Glyph } from '../../design/glyphs';
import { gradients, palette } from '../../design/palette';
import { Bloom } from '../../glyphs/Bloom';
import type { BloomBreath, BloomEvent, BloomTone } from '../../glyphs/Bloom';
import { smooth, stagger } from '../../motion/presets';
import { overlap } from '../../motion/tokens';
import { useMotionPrefs } from '../../motion/useMotionPrefs';
import { radius, space, type } from '../../theme';
import { StatusMark } from './hub';
import type { StatusLook } from './hubModel';
import { networkGlyph, testNetwork, useGlyphSize, wholeWords } from './ui';

/** The card's bloom, and the glow behind it. */
export const CARD_BLOOM = 56;
const GLOW = 168;

/**
 * Where the bloom starts as the card arrives, and when it unfolds from
 * there to where the wallet has it: as the card's entrance begins, so the
 * petals open in view (REDESIGN.md 6, Settings).
 */
export const UNFOLD_FROM = 0.6;
export const UNFOLD_AFTER = overlap.enterDelay;

/** How far the glow dims behind a dormant bloom, as the backdrop's does. */
const DORMANT_GLOW = 0.25;

/**
 * The bloom's one-off: it wilts when setup stops short, holding the droop
 * for as long as setup stays stopped, and it bursts when the wallet starts
 * answering while the card is shown, as a wallet back from offline does
 * (REDESIGN.md 7, R-5). A card drawn with setup already stopped starts
 * wilted, without the shake.
 */
export function useCardEvent(
  droop: boolean,
  live: boolean,
): BloomEvent | undefined {
  const [event, setEvent] = useState<BloomEvent | undefined>(() =>
    droop ? { kind: 'wilt', key: 1 } : undefined,
  );
  // Counted apart from the event, so one that follows a cleared wilt is
  // still a new key.
  const count = useRef(1);
  const last = useRef({ droop, live });
  useEffect(() => {
    const before = last.current;
    last.current = { droop, live };
    if (droop && !before.droop) {
      count.current += 1;
      setEvent({ kind: 'wilt', key: count.current });
    } else if (!droop && before.droop) {
      setEvent(prior => (prior?.kind === 'wilt' ? undefined : prior));
    } else if (live && !before.live && !droop) {
      count.current += 1;
      setEvent({ kind: 'burst', key: count.current });
    }
  }, [droop, live]);
  return event;
}

/**
 * How open the bloom is drawn: from `UNFOLD_FROM` as the card mounts, then
 * `open` once the card's entrance begins, each petal springing open on the
 * reveal spring as the unfold passes it. Under Reduce Motion it is drawn
 * where it rests from the first frame.
 */
function useUnfold(open: number): number {
  const { reduced } = useMotionPrefs();
  const [unfolded, setUnfolded] = useState(reduced);
  useEffect(() => {
    if (unfolded || reduced) return;
    const timer = setTimeout(() => setUnfolded(true), UNFOLD_AFTER);
    return () => clearTimeout(timer);
  }, [unfolded, reduced]);
  return unfolded || reduced ? open : Math.min(open, UNFOLD_FROM);
}

/**
 * The glow behind the bloom, still: the top pane's bloom glow (REDESIGN.md
 * 3.2, G1), bloomNight fading to nothing, or slate's on a test network, and
 * dimmed behind a dormant bloom.
 */
const Glow = memo(function CardGlow({
  test,
  dim,
}: {
  test: boolean;
  dim: boolean;
}) {
  const id = `cardGlow${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const stops = test ? gradients.G1.test : gradients.G1.stops;
  return (
    <View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[styles.glow, dim && styles.glowDim]}
    >
      <Svg width={GLOW} height={GLOW}>
        <Defs>
          <RadialGradient
            id={id}
            gradientUnits="userSpaceOnUse"
            cx={GLOW / 2}
            cy={GLOW / 2}
            r={GLOW / 2}
          >
            {stops.map(stop => (
              <Stop
                key={stop.offset}
                offset={stop.offset}
                stopColor={stop.color}
                stopOpacity={stop.opacity}
              />
            ))}
          </RadialGradient>
        </Defs>
        <Rect width={GLOW} height={GLOW} fill={`url(#${id})`} />
      </Svg>
    </View>
  );
});

/**
 * The card at the top of Settings: the wallet as the page holds it.
 *
 * Its bloom is the status row's mark grown to 56pt (`cardBloom`): it
 * breathes at rest and rests with the other decoration after 20s, ratchets
 * while the wallet refreshes or the engine starts, which never rests, opens
 * to .6 with its centre breathing while setup is under way, wilts with a
 * honey pip once setup stops short, wears the honey halo while the
 * recovery phrase is still to save, and turns slate on a test network. It
 * unfolds as the card arrives, and bursts if the wallet starts answering
 * while the card is shown. Behind it, a still glow in the top pane's light.
 *
 * Under it, the wallet's name, and a line of facts that wraps and stays
 * centred: the network as a mocha tag, its glyph a flask on a test network,
 * and whether the primary node answers (`answering`), a sage dot, or a
 * honey one that breathes while it is sought.
 *
 * A screen reader hears it as one summary (`said`).
 */
export const WalletCard = memo(function WalletCardView({
  name,
  network,
  mode,
  breath,
  open,
  tone,
  halo,
  droop,
  live,
  status,
  look,
  said,
  step,
}: {
  name: string;
  network: string;
  mode: 'breathe' | 'ratchet';
  breath: BloomBreath;
  open: number;
  tone: BloomTone;
  halo: boolean;
  droop: boolean;
  /** The primary node answers (`answering`). */
  live: boolean;
  /** The connection in words, and its mark. */
  status: string;
  look: StatusLook | null;
  /** Everything the card shows, as one line (`cardWords`). */
  said: string;
  step: number;
}) {
  const event = useCardEvent(droop, live);
  const unfold = useUnfold(open);
  const glyph = useGlyphSize(14);
  const test = testNetwork(network);
  return (
    <Reanimated.View
      entering={stagger(step)}
      layout={smooth()}
      style={styles.card}
    >
      <View
        accessible
        accessibilityRole="summary"
        accessibilityLabel={said}
        style={styles.inner}
      >
        <View style={styles.mark}>
          <Glow test={test} dim={tone === 'dormant'} />
          <Bloom
            size={CARD_BLOOM}
            detail="mark"
            mode={mode}
            breath={breath}
            open={unfold}
            tone={tone}
            halo={halo}
            event={event}
          />
          {droop ? <View testID="card-pip" style={styles.pip} /> : null}
        </View>
        <Text {...wholeWords(name)} style={styles.name}>
          {name}
        </Text>
        <View style={styles.facts}>
          <View style={styles.tag}>
            <Glyph
              name={networkGlyph(network)}
              size={glyph}
              color={test ? palette.slate : palette.bloom}
            />
            <Text {...wholeWords(network)} style={styles.tagText}>
              {network}
            </Text>
          </View>
          <View style={styles.status}>
            {look ? <StatusMark look={look} /> : null}
            <Text {...wholeWords(status)} style={styles.statusText}>
              {status}
            </Text>
          </View>
        </View>
      </View>
    </Reanimated.View>
  );
});

/** The pip sits at the bloom's upper right, just inside its petals' reach. */
const PIP = 6;
const PIP_INSET = 6;

const styles = StyleSheet.create({
  card: {
    backgroundColor: palette.espresso,
    borderRadius: radius.lg,
    overflow: 'hidden',
  },
  inner: {
    paddingVertical: space.xl,
    paddingHorizontal: space.lg,
    alignItems: 'center',
    gap: space.sm,
  },
  mark: {
    width: CARD_BLOOM,
    height: CARD_BLOOM,
    alignItems: 'center',
    justifyContent: 'center',
  },
  glow: {
    position: 'absolute',
    width: GLOW,
    height: GLOW,
    left: (CARD_BLOOM - GLOW) / 2,
    top: (CARD_BLOOM - GLOW) / 2,
  },
  glowDim: { opacity: DORMANT_GLOW },
  pip: {
    position: 'absolute',
    top: PIP_INSET,
    right: PIP_INSET,
    width: PIP,
    height: PIP,
    borderRadius: PIP / 2,
    backgroundColor: palette.honey,
  },
  name: {
    ...type.heading,
    color: palette.cream,
    textAlign: 'center',
    alignSelf: 'stretch',
  },
  // One line while both fit, centred; past that each takes a line.
  facts: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    alignItems: 'center',
    columnGap: space.sm,
    rowGap: space.xs,
  },
  tag: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xxs,
    paddingHorizontal: space.sm,
    paddingVertical: space.xxs,
    borderRadius: radius.round,
    backgroundColor: palette.mocha,
  },
  tagText: { ...type.label, color: palette.cream, flexShrink: 1 },
  status: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    flexShrink: 1,
  },
  statusText: { ...type.meta, color: palette.steam, flexShrink: 1 },
});
