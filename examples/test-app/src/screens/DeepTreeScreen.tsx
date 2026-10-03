import { useLocalSearchParams } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import { useAppColors, type AppColors } from '../theme';

/**
 * A synthetic deep accessibility tree for host AX bridge recovery benchmarks: `chain` nested
 * views deep, with `width` labelled siblings at every level. Deep React Native screens make the
 * accessibility server reject bulk snapshot requests above a size-dependent depth, and this screen
 * reproduces that shape without a third-party app. Every level opts out of view flattening, so the
 * native hierarchy is as deep as the React tree.
 */
export function DeepTreeScreen() {
  const colors = useAppColors();
  const styles = createStyles(colors);
  const params = useLocalSearchParams<{ chain?: string; width?: string }>();
  const chain = clampInteger(params.chain, 80, 1, 200);
  const width = clampInteger(params.width, 1, 0, 8);

  return (
    <View accessible={false} style={styles.frame} testID="deep-tree-root">
      <Text style={styles.title} testID="deep-tree-title">
        Deep tree {chain}x{width}
      </Text>
      <DeepLevel chain={chain} level={0} styles={styles} width={width} />
    </View>
  );
}

function DeepLevel({
  level,
  chain,
  width,
  styles,
}: {
  level: number;
  chain: number;
  width: number;
  styles: ReturnType<typeof createStyles>;
}) {
  if (level >= chain) {
    return (
      <Text style={styles.leaf} testID="deep-tree-leaf">
        Leaf at level {level}
      </Text>
    );
  }
  return (
    <View
      accessible={false}
      collapsable={false}
      style={styles.level}
      testID={`deep-tree-level-${level}`}
    >
      {Array.from({ length: width }, (_, index) => (
        <Text key={index} style={styles.sibling}>
          Row {level}.{index}
        </Text>
      ))}
      <DeepLevel chain={chain} level={level + 1} styles={styles} width={width} />
    </View>
  );
}

function clampInteger(value: string | undefined, fallback: number, min: number, max: number) {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function createStyles(colors: AppColors) {
  return StyleSheet.create({
    frame: {
      flex: 1,
      paddingHorizontal: 12,
      paddingTop: 24,
    },
    title: {
      color: colors.text,
      fontSize: 18,
      fontWeight: '600',
      marginBottom: 8,
    },
    level: {
      paddingLeft: 1,
    },
    sibling: {
      color: colors.textSoft,
      fontSize: 9,
      lineHeight: 10,
    },
    leaf: {
      color: colors.accent,
      fontSize: 12,
    },
  });
}
