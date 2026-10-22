import { useEffect, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';

import { clampInteger } from '../route-params';
import { useAppColors, type AppColors } from '../theme';

/**
 * A list whose every row repaints on a timer: `rows` rows of counters that advance every
 * `intervalMs`. The screen never goes idle, so it reproduces the accessibility capture cost of a
 * live dashboard (tester-army/e2e#841) without a third-party app. The Stop button freezes it for an
 * A/B against the same tree at rest.
 */
export function TickerScreen() {
  const colors = useAppColors();
  const styles = createStyles(colors);
  const params = useLocalSearchParams<{ rows?: string; intervalMs?: string }>();
  const rows = clampInteger(params.rows, 30, 1, 200);
  const intervalMs = clampInteger(params.intervalMs, 1000, 50, 10_000);
  const [tick, setTick] = useState(0);
  const [running, setRunning] = useState(true);

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setTick((value) => value + 1), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs, running]);

  const data = Array.from({ length: rows }, (_, index) => index);
  return (
    <View style={styles.frame} testID="ticker-root">
      <Text style={styles.title} testID="ticker-title">
        Ticker {rows} rows every {intervalMs} ms
      </Text>
      <Pressable
        accessibilityRole="button"
        onPress={() => setRunning((value) => !value)}
        style={styles.button}
        testID="ticker-toggle"
      >
        <Text style={styles.buttonLabel}>{running ? 'Stop' : 'Start'}</Text>
      </Pressable>
      <FlatList
        data={data}
        keyExtractor={String}
        renderItem={({ item }) => (
          <View style={styles.row} testID={`ticker-row-${item}`}>
            <Text style={styles.cell}>Row {item}</Text>
            <Text style={styles.cell} testID={`ticker-value-${item}`}>
              {tick + item}
            </Text>
            <Text style={styles.cell}>{(tick + item) * 2}</Text>
            <Text style={styles.cell}>{(tick + item) * 3}</Text>
            <Pressable
              accessibilityRole="button"
              style={styles.rowButton}
              testID={`ticker-a-${item}`}
            >
              <Text style={styles.rowButtonLabel}>A{item}</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              style={styles.rowButton}
              testID={`ticker-b-${item}`}
            >
              <Text style={styles.rowButtonLabel}>B{item}</Text>
            </Pressable>
          </View>
        )}
      />
    </View>
  );
}

function createStyles(colors: AppColors) {
  return StyleSheet.create({
    frame: { flex: 1, backgroundColor: colors.surface, padding: 12 },
    title: { color: colors.text, fontSize: 18, fontWeight: '600', marginBottom: 8 },
    button: {
      alignSelf: 'flex-start',
      backgroundColor: colors.accent,
      borderRadius: 6,
      paddingHorizontal: 12,
      paddingVertical: 6,
      marginBottom: 8,
    },
    buttonLabel: { color: colors.surface, fontWeight: '600' },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      paddingVertical: 4,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.line,
    },
    cell: { color: colors.text, minWidth: 44 },
    rowButton: {
      borderWidth: 1,
      borderColor: colors.line,
      borderRadius: 4,
      paddingHorizontal: 6,
      paddingVertical: 2,
    },
    rowButtonLabel: { color: colors.text, fontSize: 12 },
  });
}
