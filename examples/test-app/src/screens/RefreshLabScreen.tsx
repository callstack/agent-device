import { useCallback, useState } from 'react';
import { ActivityIndicator, FlatList, RefreshControl, StyleSheet, Text, View } from 'react-native';

/**
 * Pull-to-refresh lab: a `RefreshControl` on a `FlatList` with a durable counter, so an agent can
 * prove a refresh actually ran. `refresh-count` increments when a refresh starts, `refresh-state`
 * names the visible state while it runs (`refreshing` with the spinner, then back to `idle`),
 * and each refresh takes REFRESH_MS so the in-progress state is observable.
 */
const REFRESH_MS = 1500;
const ITEM_COUNT = 30;

export function RefreshLabScreen() {
  const [refreshing, setRefreshing] = useState(false);
  const [count, setCount] = useState(0);
  const [stamp, setStamp] = useState(0);
  const items = Array.from({ length: ITEM_COUNT }, (_, id) => id + stamp * ITEM_COUNT);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    setCount((current) => current + 1);
    setTimeout(() => {
      setStamp((current) => current + 1);
      setRefreshing(false);
    }, REFRESH_MS);
  }, []);

  return (
    <View style={styles.frame} testID="refresh-lab-root">
      <Text style={styles.title}>Refresh lab</Text>
      <Text style={styles.status} testID="refresh-count">
        {`Refreshed ${count} times`}
      </Text>
      <View style={styles.row} testID="refresh-state-row">
        {refreshing ? <ActivityIndicator testID="refresh-spinner" /> : null}
        <Text style={styles.status} testID="refresh-state">
          {refreshing ? 'refreshing' : 'idle'}
        </Text>
      </View>
      <FlatList
        data={items}
        keyExtractor={String}
        refreshControl={<RefreshControl onRefresh={onRefresh} refreshing={refreshing} />}
        renderItem={({ item }) => (
          <View style={styles.rowItem}>
            <Text style={styles.itemText}>{`Item ${item}`}</Text>
          </View>
        )}
        testID="refresh-list"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  frame: { flex: 1, gap: 8, padding: 24, paddingTop: 72, backgroundColor: '#fff' },
  title: { fontSize: 24, fontWeight: '700' },
  status: { fontSize: 16 },
  row: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  rowItem: { borderBottomColor: '#ddd', borderBottomWidth: 1, paddingVertical: 12 },
  itemText: { fontSize: 16 },
});
