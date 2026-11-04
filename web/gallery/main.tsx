/**
 * Desktop gallery entry: the mobile gallery's states (native-tests/Gallery.tsx
 * upstream) drawn by the desktop renderer, one at a time, for
 * scripts/desktop/gallery.mjs to capture and audit. Built only by
 * vite.gallery.config.ts, so nothing here reaches the production bundle.
 *
 * Without a runner it walks every state in turn, as the mobile gallery does.
 */
// First, so nothing drawn after it can reach the real store or network.
import { breaches } from './breaches';
import { forgetFace, setBiometry } from './sealed';
import { Buffer } from 'buffer';
import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { StyleSheet, Text } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ToastProvider } from '../chicory/src/components/Toast';
import { wakeAmbient } from '../chicory/src/motion/ambient';
import { clearHeldRequests } from '../chicory/src/stage/heldRequests';
import { colors } from '../chicory/src/theme';
import { Probe, perform, report } from './drive';
import { GLYPHS } from './glyphs';
import { PAYMENTS } from './payments';
import { SCENES } from './scenes';
import type { Take } from './shots';
import '../style.css';

Object.assign(globalThis, { Buffer });

/** How long a walked state holds once its steps have brought it about. */
const DWELL_MS = 1200;

// States from the shared scene list that this desktop build does not draw.
const ABSENT = new Set<string>();

export const SHOTS = [...GLYPHS, ...SCENES, ...PAYMENTS].filter(shot => !ABSENT.has(shot.name));

type Status = 'drawing' | 'reached';
const listeners = new Set<(index: number) => void>();
const gallery = {
  names: SHOTS.map(shot => shot.name),
  index: -1,
  status: 'drawing' as Status,
  /** Every GALLERY line since the state at `index` came up. */
  reports: [] as string[],
  breaches,
  /** Draws the state at `index` from nothing and holds it once reached. */
  go(index: number) {
    gallery.index = index;
    gallery.status = 'drawing';
    gallery.reports = [];
    for (const listener of listeners) listener(index);
  },
};
Object.assign(window, { chicoryGallery: gallery });

const log = console.log.bind(console);
console.log = (...args: unknown[]) => {
  if (typeof args[0] === 'string' && args[0].startsWith('GALLERY ')) gallery.reports.push(args[0]);
  log(...args);
};

const driven = new URLSearchParams(location.search).has('driven');

function Gallery() {
  const [cursor, setCursor] = useState({ index: driven ? -1 : 0, run: 0 });
  const [drawn, setDrawn] = useState<{ take: Take; name: string; key: number } | null>(null);
  const probe = useRef<Probe>(null);

  useEffect(() => {
    const go = (index: number) => setCursor(last => ({ index, run: last.run + 1 }));
    listeners.add(go);
    return () => {
      listeners.delete(go);
    };
  }, []);

  useEffect(() => {
    const { index } = cursor;
    if (index < 0) return;
    const shot = SHOTS[index];
    report(`${index} ${shot.name}`);
    clearHeldRequests();
    forgetFace();
    setBiometry(null);
    wakeAmbient();
    const take = shot.make();
    setDrawn(last => ({ take, name: shot.name, key: (last?.key ?? 0) + 1 }));
    return perform(probe, shot.name, take.steps ?? [], driven ? 0 : (shot.hold ?? DWELL_MS), () => {
      if (driven) {
        gallery.status = 'reached';
        report(`REACHED ${index}`);
        return;
      }
      const last = index === SHOTS.length - 1;
      if (last) report('COMPLETE');
      setCursor(at => ({ index: last ? 0 : index + 1, run: at.run + 1 }));
    });
  }, [cursor]);

  return (
    <GestureHandlerRootView style={styles.root}>
      <SafeAreaProvider>
        <ToastProvider>
          {drawn ? (
            <Probe key={drawn.key} ref={probe} name={drawn.name}>
              {drawn.take.view}
            </Probe>
          ) : null}
          {!driven && (
            <Text style={styles.index} pointerEvents="none">
              {cursor.index}
            </Text>
          )}
        </ToastProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  index: { position: 'absolute', left: 6, bottom: 2, fontSize: 9, color: colors.text, opacity: 0.5 },
});

document.documentElement.dataset.gallery = 'true';
createRoot(document.getElementById('root')!).render(
  <div className="wallet-frame">
    <Gallery />
  </div>,
);
