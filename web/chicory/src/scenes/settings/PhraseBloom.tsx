import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { copy } from '../../design/copy';
import { haptics } from '../../design/haptics';
import { Bloom } from '../../glyphs/Bloom';
import type { BloomEvent } from '../../glyphs/Bloom';
import { RING, phraseBloom } from './motion';

const SIZE = 120;

/**
 * What the bloom plays as the count reaches `count`: a burst at exactly 12
 * or 24, a shake past 24, and a wilt for as long as the wallet refuses the
 * phrase. Each new moment takes the next key, so a count that comes back to
 * 12 bursts again.
 */
function nextEvent(
  count: number,
  wilted: boolean,
  key: number,
): BloomEvent | undefined {
  if (wilted) return { kind: 'wilt', key };
  if (count > 2 * RING) return { kind: 'shake', key };
  if (phraseBloom(count).ready) return { kind: 'burst', key };
  return undefined;
}

/**
 * Restore entry's count of words (REDESIGN.md 6, Backup and setup), drawn
 * by the bloom's own count (`lit`): each typed word lights the next petal,
 * clockwise from the top, and from the thirteenth a second ring lights
 * behind the first. Exactly 12 or 24 bursts it, which is when the restore
 * control wakes. More than 24 turns the petals radish and shakes them, and
 * a phrase the wallet refused wilts them to dust.
 *
 * `test` draws a test network's phrase in slate, as the mark does.
 */
export function PhraseBloom({
  count,
  test = false,
  wilted = false,
}: {
  count: number;
  test?: boolean;
  wilted?: boolean;
}) {
  const { ready } = phraseBloom(count);
  // Worked out as the count changes, not after, so the bloom plays it in
  // the same frame the petal lights.
  const [moment, setMoment] = useState({
    count,
    wilted,
    key: 0,
    event: undefined as BloomEvent | undefined,
  });
  if (moment.count !== count || moment.wilted !== wilted) {
    const key = moment.key + 1;
    setMoment({ count, wilted, key, event: nextEvent(count, wilted, key) });
  }

  const before = useRef(count);
  useEffect(() => {
    const was = before.current;
    before.current = count;
    if (count === was) return;
    if (count > 2 * RING) haptics.rigid();
    else if (phraseBloom(count).ready) haptics.success();
    else if (count > was) haptics.soft();
  }, [count]);
  useEffect(() => {
    if (wilted) haptics.error();
  }, [wilted]);

  const words = copy.settings.create;
  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={words.words}
      accessibilityValue={{
        min: 0,
        max: 2 * RING,
        now: count,
        ...(count
          ? {
              text: ready ? words.wordsReady(count) : words.wordCount(count),
            }
          : {}),
      }}
      style={styles.bloom}
    >
      <Bloom
        size={SIZE}
        lit={count}
        tone={test ? 'test' : 'live'}
        event={moment.event}
        detail="full"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  bloom: {
    width: SIZE,
    height: SIZE,
    alignSelf: 'center',
  },
});
