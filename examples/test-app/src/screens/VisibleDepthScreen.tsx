import { Pressable, StyleSheet, View } from 'react-native';

import { useAppColors, type AppColors } from '../theme';

export function VisibleDepthScreen() {
  const colors = useAppColors();
  const styles = createStyles(colors);

  return (
    <View accessible={false} style={styles.frame}>
      <Pressable
        accessibilityRole="button"
        style={styles.projectedChild}
        testID="visible-depth-projected-child"
      />
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
    projectedChild: {
      alignItems: 'center',
      backgroundColor: colors.accent,
      borderRadius: 6,
      left: 16,
      minHeight: 52,
      paddingHorizontal: 18,
      paddingVertical: 14,
      position: 'absolute',
      top: 164,
      width: 220,
    },
  });
}
