import React, { useMemo } from 'react';
import {
  RefreshControl,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';
import { copy } from '../../design/copy';
import { palette } from '../../design/palette';
import { SettingsScreen } from '../../screens/Settings';
import type { RegionProps } from '../../stage/Canvas';
import { STATUS_ROW } from '../../stage/layout';
import {
  CORNER_REACH,
  CORNER_TARGET,
  CornerControl,
} from '../../stage/panes/CornerControl';
import { SceneSlot } from '../../stage/panes/SceneSlot';
import { useSceneBack } from '../../stage/StageContext';
import { useScanRequest } from '../../stage/useScanReceiver';
import { space, type } from '../../theme';
import { SettingsHostContext } from './host';
import type { SettingsHost } from './host';
import { useReveal } from './reveal';
import {
  Note,
  SettingsSurface,
  accentFor,
  glyphScale,
  testNetwork,
} from './ui';

/**
 * How far the fade under Settings' bar reaches down over the page: the
 * slot's own top padding, so a card at rest starts where the fade ends and
 * only a card scrolled up under the title fades.
 */
export const TITLE_FADE = space.md;

/**
 * A short roast fade under the bar, so a card scrolled up under the title
 * goes into the ground rather than being cut on a hard line. It hangs from
 * the bar's foot, whatever height the text size gives the bar, and the bar
 * is raised over the page so the fade draws over it. It takes no touches.
 *
 * It hangs from the bar rather than sitting over the page in a box of their
 * own because the page's keyboard offset is measured from the top of
 * Settings (`SceneSlot`): the page must stay the surface's own child.
 */
function TitleFade() {
  return (
    <View
      testID="settings-title-fade"
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={styles.fade}
    >
      <Svg width="100%" height="100%" preserveAspectRatio="none">
        <Defs>
          <LinearGradient id="settingsTitleFade" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={palette.roast} stopOpacity={1} />
            <Stop offset="1" stopColor={palette.roast} stopOpacity={0} />
          </LinearGradient>
        </Defs>
        <Rect width="100%" height="100%" fill="url(#settingsTitleFade)" />
      </Svg>
    </View>
  );
}

/**
 * Settings, the one scene that may keep words on screen (REDESIGN.md rule
 * 2): its title and close control, a failed refresh if there is one, then
 * everything it holds. A recovery phrase still to be saved is drawn by
 * Settings itself, as its leading section.
 *
 * Its root carries the copy guard's marker, `scene-settings`, which lets
 * the guard skip everything under it. No other scene may render one; only
 * the setup surfaces do (the new wallet sheet, and the setup panel a phase
 * opens for network setup or the recovery phrase), and none of them is ever
 * drawn beside Settings.
 *
 * On a test network its pull to refresh turns in slate rather than bloom, as
 * the page under it draws (`SettingsScreen`).
 *
 * Its bar grows with the text size, which Settings does not cap: the title
 * keeps to its one word and gives way before the close control does, so the
 * close stays on screen at every size. The close grows with the text as the
 * page's glyphs do (`glyphScale`), its target with it.
 *
 * The page scrolls under the bar into a short roast fade (`TitleFade`), and
 * under the home indicator to the screen's edge: the inset is room at the
 * end of what scrolls, not a margin that cuts the page off above it.
 *
 * It hosts the page (`SettingsHost`): Android back reaches the page's own
 * steps through the stage, a field that scans a code, the primary node's
 * address or the address the wallet empties to, opens the stage's scan
 * overlay over Settings rather than a camera of its own
 * (`useScanRequest`), and a row that opens below the fold is scrolled into
 * view (`useReveal`). What the page reads of the wallet after its own
 * changes is the quiet read (`session.refresh`); only saving or retrying the
 * primary node, and a pull, restart and resync the wallet behind the
 * spinner.
 *
 * The page's card reads the wallet as the status row's mark does, so it
 * hears whether the engine is still starting or a refresh runs, and
 * whether the balance is too old to trust (`stale`), as the canvas does.
 */
export function SettingsLayer({
  snapshot,
  client,
  session,
  view,
  stale,
  backup,
}: RegionProps) {
  // Settings covers the whole canvas, under the system bars too, so it
  // starts below the status bar. Starting there, rather than padding down to
  // it, keeps the slot's keyboard offset measured from the top of the safe
  // area. At the foot it runs to the screen's edge, and the home indicator's
  // inset is added to the end of the page instead.
  const { top, bottom } = useSafeAreaInsets();
  const { fontScale } = useWindowDimensions();
  const grow = glyphScale(fontScale);
  const { accent } = accentFor(testNetwork(snapshot.wallet.network));
  const scan = useScanRequest();
  // The band the title's fade covers and the home indicator's are not in
  // view, for a row brought into view as it opens.
  const { scroll, reveal } = useReveal({ top: TITLE_FADE, bottom });
  const host = useMemo<SettingsHost>(
    () => ({ useBack: useSceneBack, scan, reveal }),
    [scan, reveal],
  );
  return (
    <SettingsHostContext.Provider value={host}>
      <SettingsSurface style={[styles.layer, { marginTop: top }]}>
        <View style={styles.bar}>
          {/* The slot below names the scene for a screen reader already. */}
          <Text
            accessibilityElementsHidden
            importantForAccessibility="no"
            numberOfLines={1}
            adjustsFontSizeToFit
            minimumFontScale={0.5}
            style={styles.title}
          >
            {copy.settings.title}
          </Text>
          {/* Drawn at the text's scale, its glyph and its target together,
        rather than scaled up from 48pt; the box around it gives the bar the
        room it takes. */}
          <View
            style={[
              styles.close,
              { width: CORNER_TARGET * grow, height: CORNER_TARGET * grow },
            ]}
          >
            <CornerControl home={false} scale={grow} />
          </View>
          <TitleFade />
        </View>
        <SceneSlot
          label={copy.settings.title}
          scroll={scroll}
          refreshControl={
            <RefreshControl
              refreshing={session.refreshing}
              onRefresh={session.manualRefresh}
              tintColor={accent}
              colors={[accent]}
            />
          }
        >
          <View style={[styles.stack, { paddingBottom: bottom }]}>
            {session.error ? (
              <Note tone="error">
                {copy.notice.refreshFailed(session.error)}
              </Note>
            ) : null}
            <SettingsScreen
              snapshot={snapshot}
              client={client}
              switchError={session.switchError}
              onDisconnect={session.disconnect}
              onRefresh={session.manualRefresh}
              onRead={session.refresh}
              onNetwork={session.switchNetwork}
              onErase={session.eraseDevice}
              backupPending={backup?.pending}
              onBackupSaved={backup?.onSaved}
              unit={view.unit}
              symbol={view.symbol}
              connecting={session.connecting}
              refreshing={session.refreshing}
              stale={stale}
            />
          </View>
        </SceneSlot>
      </SettingsSurface>
    </SettingsHostContext.Provider>
  );
}

const styles = StyleSheet.create({
  layer: { flex: 1 },
  // At least the status row's height, and taller when the title is.
  // The close's 48pt target reaches past the page edge by CORNER_REACH, as
  // the canvas's cog does, so its glyph sits where the cog's sat.
  bar: {
    minHeight: STATUS_ROW,
    paddingLeft: space.xl,
    paddingRight: space.xl - CORNER_REACH,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: space.sm,
    // Over the page below it, so the fade it hangs draws over the cards.
    zIndex: 1,
  },
  title: { ...type.title, color: palette.cream, flexShrink: 1 },
  close: { alignItems: 'center', justifyContent: 'center' },
  fade: {
    position: 'absolute',
    top: '100%',
    left: 0,
    right: 0,
    height: TITLE_FADE,
  },
  stack: { gap: space.md },
});
