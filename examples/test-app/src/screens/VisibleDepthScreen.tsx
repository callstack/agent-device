import { Pressable, StyleSheet, View } from 'react-native';

import { useAppColors, type AppColors } from '../theme';

/**
 * Keeps the structural wrapper outside the viewport while its independent child projects into
 * it. Its stable test ID makes the wrapper acquisition-eligible without turning its ancestors into
 * labeled structural nodes; it must stay an `Other` node in XCTest rather than a scroll/container
 * type that owns descendant visibility.
 */
export function VisibleDepthScreen() {
  const colors = useAppColors();
  const styles = createStyles(colors);

  return (
    <View accessible={false} style={styles.frame}>
      <View
        accessible={false}
        style={styles.clippedParent}
        testID="visible-depth-clipped-parent"
      >
        <Pressable
          accessibilityRole="button"
          style={styles.projectedChild}
          testID="visible-depth-projected-child"
        />
      </View>
    </View>
  );
}

function createStyles(colors: AppColors) {
  return StyleSheet.create({
    frame: {
      flex: 1,
      paddingHorizontal: 18,
      paddingTop: 24,
    },
    clippedParent: {
      height: 64,
      left: -96,
      overflow: 'visible',
      position: 'absolute',
      top: 164,
      width: 64,
    },
    projectedChild: {
      alignItems: 'center',
      backgroundColor: colors.accent,
      borderRadius: 6,
      left: 112,
      minHeight: 52,
      paddingHorizontal: 18,
      paddingVertical: 14,
      position: 'absolute',
      top: 0,
      width: 220,
    },
  });
}
