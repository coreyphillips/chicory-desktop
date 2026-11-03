import React from 'react';
import type { PropsWithChildren } from 'react';
import { StyleSheet } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import Reanimated from 'react-native-reanimated';
import { sceneIn } from '../../motion/presets';

/**
 * A scene in the top slot. It arrives once the outgoing one is on its way,
 * so for a moment both are drawn and neither pops. The canvas keys it by
 * scene, so each open arrives afresh, and fades it out with a style of the
 * slot's own as it leaves (`SceneLeave`), never a layout exit, which the
 * device drew over the sheet and Home.
 */
export function Arriving({
  style,
  children,
}: PropsWithChildren<{ style?: StyleProp<ViewStyle> }>) {
  return (
    <Reanimated.View entering={sceneIn()} style={[styles.flex, style]}>
      {children}
    </Reanimated.View>
  );
}

const styles = StyleSheet.create({ flex: { flex: 1 } });
