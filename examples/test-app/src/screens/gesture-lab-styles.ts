import { StyleSheet } from 'react-native';

import type { AppColors } from '../theme';

export function createGestureLabStyles(colors: AppColors) {
  return StyleSheet.create({
    target: {
      alignItems: 'center',
      backgroundColor: colors.cardStrong,
      borderColor: colors.line,
      borderRadius: 4,
      borderWidth: StyleSheet.hairlineWidth,
      height: 220,
      justifyContent: 'center',
      overflow: 'hidden',
    },
    image: {
      borderRadius: 4,
      height: 160,
      width: 240,
    },
    androidTransformTarget: {
      bottom: 0,
      left: 0,
      position: 'absolute',
      right: 0,
      top: 0,
      zIndex: 1,
    },
    twoPointerTarget: {
      bottom: 0,
      left: 0,
      position: 'absolute',
      top: 0,
      width: '50%',
      zIndex: 1,
    },
    metrics: {
      gap: 6,
    },
    metric: {
      color: colors.textSoft,
      fontSize: 13,
      fontWeight: '600',
      lineHeight: 18,
    },
  });
}
