import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Reanimated, { useDerivedValue } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { copy } from '../../design/copy';
import { Glyph } from '../../design/glyphs';
import { haptics } from '../../design/haptics';
import { palette } from '../../design/palette';
import { Bloom } from '../../glyphs/Bloom';
import type { BloomEvent } from '../../glyphs/Bloom';
import { PulseDot } from '../../glyphs/PulseDot';
import { Whisper } from '../../glyphs/Whisper';
import { riseIn } from '../../motion/presets';
import { useMotionPrefs } from '../../motion/useMotionPrefs';
import type { RegionProps } from '../../stage/Canvas';
import type { CanvasSceneName } from '../../stage/layout';
import { STATUS_ROW } from '../../stage/layout';
import { CORNER_ROOM } from '../../stage/panes/CornerControl';
import { useBuild } from '../../stage/panes/Build';
import { usePaneActive, usePanes } from '../../stage/panes/Pane';
import { useStage } from '../../stage/StageContext';
import { HIT_SLOP, space } from '../../theme';
import { BackupTile } from './BackupTile';
import { pullProgress } from './motion';
import { useAppActive } from './useAppActive';
import { healthText, markVisual } from './visual';

/** The mark's size, and the touch target around it. */
const MARK = 28;
const TARGET = 48;

/**
 * The status row, which every scene on the canvas keeps: the bloom mark,
 * which is how the wallet is, and at home the shield tile of a recovery
 * phrase still to save. The canvas runs under the system status bar, so the
 * row starts below it.
 *
 * The mark is the refresh control. Its petals open with the wallet's
 * lightning setup, ratchet while a refresh runs and go dormant while the
 * balance is old. A pull on the home pane folds them and opens them again a
 * petal each twelfth of the way, so the mark is in full flower when letting
 * go would refresh (REDESIGN.md 6). Its PulseDot is the connection. What it all means is its
 * accessibility value, and a long press whispers it. The network shows as a
 * colour, slate off mainnet with a flask beside the mark, and the wallet's
 * name is left to Settings.
 *
 * The corner control at its right is the canvas's own, drawn after Home so a
 * screen reader reaches it in order (REDESIGN.md 9); the row leaves it room.
 */
export function StatusRow({
  shown,
  snapshot,
  session,
  stale,
  backup,
  arrived,
}: RegionProps & {
  /** The scene the canvas shows. */
  shown: CanvasSceneName;
}) {
  const live = usePaneActive();
  const { actions } = useStage();
  const { top } = useSafeAreaInsets();
  const { reduced } = useMotionPrefs();
  const awake = useAppActive();
  const refreshing = session.refreshing || session.connecting;
  const health = {
    snapshot,
    stale,
    refreshing: session.refreshing,
    connecting: session.connecting,
    error: session.error,
    backupPending: !!backup?.pending,
  };
  const mark = markVisual(health);
  const value = healthText(health);
  // A wallet back from offline bursts its mark as the canvas builds in
  // (REDESIGN.md 7, R-5).
  const build = useBuild();
  const [reconnected] = useState(() => build?.arrival === 'reconnect');
  const event = useMarkEvent(mark.droop, arrived, reconnected);
  const { pull } = usePanes();
  const opening = useDerivedValue(() => pullProgress(pull.get()));
  const refresh = useCallback(() => {
    haptics.tick();
    session.manualRefresh();
  }, [session]);
  return (
    <View
      style={[styles.status, { paddingTop: top, height: top + STATUS_ROW }]}
    >
      <View style={styles.identity}>
        <Whisper label={value}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={copy.home.refresh}
            accessibilityValue={{ text: value }}
            accessibilityState={{ disabled: refreshing, busy: refreshing }}
            disabled={refreshing}
            hitSlop={HIT_SLOP}
            onPress={live ? refresh : undefined}
            style={styles.mark}
          >
            <Bloom
              size={MARK}
              detail="mark"
              mode={mark.mode}
              breath={mark.breath}
              open={mark.open}
              tone={mark.tone}
              halo={mark.halo}
              event={event}
              opening={opening}
            />
            {/* The dot is part of the mark: its words are the mark's. */}
            <View
              style={styles.dot}
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
            >
              <PulseDot state={mark.pulse} pingKey={snapshot.updatedAt} />
            </View>
            {mark.droop ? <View style={styles.pip} /> : null}
          </Pressable>
        </Whisper>
        {/* A test network is a safety state (REDESIGN.md rule 4): the slate
            mark is its colour, the flask its shape, and the flask rising in
            as the wallet opens its motion. */}
        {mark.flask ? (
          <Reanimated.View entering={riseIn()}>
            <Glyph name="flask" size={14} color={palette.slate} />
          </Reanimated.View>
        ) : null}
        {/* The tile only leads anywhere from home; elsewhere the halo stays. */}
        {backup?.pending && shown === 'home' ? (
          <BackupTile
            running={live && awake && !reduced}
            onOpen={live ? actions.openSettings : undefined}
          />
        ) : null}
      </View>
    </View>
  );
}

/**
 * The one-off the mark plays: it wilts when setup stops short, and bursts
 * when money arrives, or as a wallet that was offline answers again
 * (`reconnected`), unless it is drooping. A wilt holds for as long as the
 * event stays one, so once setup recovers it is let go of, and the petals
 * open as far as the setup now says.
 */
function useMarkEvent(
  droop: boolean,
  arrived: number,
  reconnected = false,
): BloomEvent | undefined {
  const [event, setEvent] = useState<BloomEvent>();
  const last = useRef({ droop: false, arrived });
  // Counted apart from the event, so one that follows a cleared wilt is
  // still a new key.
  const count = useRef(0);
  const burst = useRef(reconnected);
  useEffect(() => {
    if (!burst.current) return;
    burst.current = false;
    if (droop) return;
    count.current += 1;
    setEvent({ kind: 'burst', key: count.current });
  }, [droop]);
  useEffect(() => {
    const before = last.current;
    last.current = { droop, arrived };
    const kind =
      droop && !before.droop
        ? 'wilt'
        : arrived !== before.arrived && !droop
        ? 'burst'
        : null;
    if (kind) {
      count.current += 1;
      setEvent({ kind, key: count.current });
    } else if (!droop && before.droop) {
      setEvent(prior => (prior?.kind === 'wilt' ? undefined : prior));
    }
  }, [droop, arrived]);
  return event;
}

const styles = StyleSheet.create({
  status: {
    paddingLeft: space.xl - (TARGET - MARK) / 2,
    paddingRight: space.xl + CORNER_ROOM,
    flexDirection: 'row',
    alignItems: 'center',
  },
  identity: {
    flexShrink: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
  },
  mark: {
    width: TARGET,
    height: TARGET,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // The PulseDot at the mark's lower right, and the setup pip at its upper
  // right, each just inside the petals' reach.
  dot: {
    position: 'absolute',
    right: (TARGET - MARK) / 2 - 1,
    bottom: (TARGET - MARK) / 2 - 1,
  },
  pip: {
    position: 'absolute',
    top: (TARGET - MARK) / 2 - 1,
    right: (TARGET - MARK) / 2 - 1,
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: palette.honey,
  },
});
