import React from 'react';
import Reanimated, { useAnimatedProps } from 'react-native-reanimated';
import type { SharedValue } from 'react-native-reanimated';
import Svg, { Circle, Path } from 'react-native-svg';
import { GLYPHS, GLYPH_LENGTHS, strokeFor } from '../../design/glyphs';
import type { GlyphName } from '../../design/glyphs';

/**
 * Strokes that draw themselves along their length, for the one-off draws
 * (REDESIGN.md 4, animated glyphs): a check, a ring. They animate an SVG
 * attribute, which is kept to draws that happen once; anything that loops
 * turns a still drawing instead.
 */
const AnimatedPath = Reanimated.createAnimatedComponent(Path);
const AnimatedCircle = Reanimated.createAnimatedComponent(Circle);

function DrawnPart({
  d,
  length,
  progress,
}: {
  d: string;
  length: number;
  progress: SharedValue<number>;
}) {
  // A round cap would leave a dot where nothing is drawn yet.
  const animated = useAnimatedProps(() => ({
    strokeDashoffset: length * (1 - progress.get()),
    strokeOpacity: progress.get() > 0 ? 1 : 0,
  }));
  return (
    <AnimatedPath
      d={d}
      strokeDasharray={[length, length]}
      animatedProps={animated}
    />
  );
}

/** `name` drawn as far as `progress` (0 to 1) has run, part by part. */
export function DrawnGlyph({
  name,
  size,
  color,
  progress,
}: {
  name: GlyphName;
  size: number;
  color: string;
  progress: SharedValue<number>;
}) {
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={strokeFor(size)}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {GLYPHS[name].map((part, i) => (
        <DrawnPart
          key={part.id}
          d={part.d}
          length={GLYPH_LENGTHS[name][i]}
          progress={progress}
        />
      ))}
    </Svg>
  );
}

/**
 * An arc round a circle `size` across, from twelve o'clock clockwise,
 * covering `share` (0 to 1) of it: a ring drawing itself, or growing from
 * one share to another. Its outer edge is the circle's, as Send's result
 * ring's is.
 */
export function DrawnArc({
  size,
  stroke,
  color,
  share,
}: {
  size: number;
  stroke: number;
  color: string;
  share: SharedValue<number>;
}) {
  const c = size / 2;
  const r = c - stroke / 2;
  const around = 2 * Math.PI * r;
  // One dash as long as the circle, slid back by what is not yet drawn: the
  // offset is a plain number, which the UI thread can set every frame.
  const animated = useAnimatedProps(() => ({
    strokeDashoffset: around * (1 - share.get()),
    strokeOpacity: share.get() > 0 ? 1 : 0,
  }));
  return (
    <AnimatedCircle
      cx={c}
      cy={c}
      r={r}
      fill="none"
      stroke={color}
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeDasharray={[around, around]}
      transform={`rotate(-90 ${c} ${c})`}
      animatedProps={animated}
    />
  );
}
