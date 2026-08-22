import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useAppColors, type AppColors } from '../theme';

/**
 * Keeps the structural wrapper outside the viewport while its independent child projects into
 * it. The wrapper must stay an `Other` node in XCTest: it is semantic enough to be acquisition-
 * eligible, but it is not a scroll/container type that owns descendant visibility.
 */
export function VisibleDepthScreen() {
  const colors = useAppColors();
  const styles = createStyles(colors);

  return (
    <View accessible={false} style={styles.frame}>
      <Text style={[styles.title, styles.titleSpacing]} testID="visible-depth-title">
        Regular visible depth frontier
      </Text>
      <Text style={styles.body}>
        The projected child remains visible when its clipped structural parent is collapsed.
      </Text>
      <View
        accessible={false}
        accessibilityLabel="Clipped structural parent"
        style={styles.clippedParent}
        testID="visible-depth-clipped-parent"
      >
        <Pressable
          accessibilityLabel="Projected child"
          accessibilityRole="button"
          style={styles.projectedChild}
          testID="visible-depth-projected-child"
        >
          <Text style={styles.projectedChildLabel}>Projected child</Text>
        </Pressable>
      </View>
    </View>
  );
}

function createStyles(colors: AppColors) {
  return StyleSheet.create({
    body: {
      color: colors.textSoft,
      fontSize: 16,
      lineHeight: 23,
    },
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
    projectedChildLabel: {
      color: '#ffffff',
      fontSize: 16,
      fontWeight: '700',
    },
    title: {
      color: colors.text,
      fontSize: 28,
      fontWeight: '700',
      lineHeight: 34,
    },
    titleSpacing: {
      marginBottom: 16,
    },
  });
}
