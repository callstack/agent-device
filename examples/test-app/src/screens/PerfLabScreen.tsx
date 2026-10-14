import {
  createContext,
  memo,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

/**
 * Seeded JavaScript performance problems for `react-devtools profile`. Each scenario renders one
 * culprit and a Run button that replays the slow interaction as a fixed burst, then shows
 * `done` in `perf-status`. The file imports only React and React Native so it can be dropped into
 * a bare React Native app to check the profiler on other versions.
 */
export const PERF_SCENARIOS = [
  'expensive-render',
  'memo-defeated',
  'context-cascade',
  'parent-cascade',
  'render-storm',
  'effect-chain',
  'eager-list',
] as const;

export type PerfScenario = (typeof PERF_SCENARIOS)[number];

export function isPerfScenario(value: unknown): value is PerfScenario {
  return PERF_SCENARIOS.includes(value as PerfScenario);
}

type ScenarioProps = { runId: number; onDone: () => void };

export function PerfLabScreen({ initialScenario }: { initialScenario?: PerfScenario }) {
  const [scenario, setScenario] = useState<PerfScenario>(initialScenario ?? 'expensive-render');
  const [runId, setRunId] = useState(0);
  const [status, setStatus] = useState('idle');
  const Scenario = SCENARIO_COMPONENTS[scenario];

  return (
    <View style={styles.frame} testID="perf-lab-root">
      <Text style={styles.title}>Perf lab</Text>
      <View style={styles.chips}>
        {PERF_SCENARIOS.map((id) => (
          <Pressable
            accessibilityRole="button"
            key={id}
            onPress={() => {
              setScenario(id);
              setRunId(0);
              setStatus('idle');
            }}
            style={[styles.chip, id === scenario && styles.chipSelected]}
            testID={`perf-scenario-${id}`}
          >
            <Text style={styles.chipLabel}>{id}</Text>
          </Pressable>
        ))}
      </View>
      <View style={styles.toolbar}>
        <Pressable
          accessibilityRole="button"
          onPress={() => {
            setStatus('running');
            setRunId((value) => value + 1);
          }}
          style={styles.run}
          testID="perf-run"
        >
          <Text style={styles.runLabel}>Run {scenario}</Text>
        </Pressable>
        <Text testID="perf-status">{status}</Text>
      </View>
      <Scenario key={scenario} onDone={() => setStatus('done')} runId={runId} />
    </View>
  );
}

const SCENARIO_COMPONENTS: Record<PerfScenario, (props: ScenarioProps) => ReactNode> = {
  'expensive-render': ExpensiveRenderScenario,
  'memo-defeated': MemoDefeatedScenario,
  'context-cascade': ContextCascadeScenario,
  'parent-cascade': ParentCascadeScenario,
  'render-storm': RenderStormScenario,
  'effect-chain': EffectChainScenario,
  'eager-list': EagerListScenario,
};

/** Calls `step` `count` times, `intervalMs` apart, after each new run; then reports done. */
function useBurst(
  runId: number,
  count: number,
  intervalMs: number,
  step: (index: number) => void,
  onDone: () => void,
) {
  const stepRef = useRef(step);
  stepRef.current = step;
  const doneRef = useRef(onDone);
  doneRef.current = onDone;
  useEffect(() => {
    if (runId === 0) return;
    let index = 0;
    const timer = setInterval(() => {
      if (index >= count) {
        clearInterval(timer);
        doneRef.current();
        return;
      }
      stepRef.current(index);
      index += 1;
    }, intervalMs);
    return () => clearInterval(timer);
  }, [runId, count, intervalMs]);
}

function busyWork(iterations: number, seed: number): number {
  let value = seed;
  for (let index = 0; index < iterations; index += 1) {
    value = (value * 1103515245 + 12345) % 2147483647;
  }
  return value;
}

// expensive-render: the chart recomputes its trend line on every render instead of memoizing it.
function ExpensiveRenderScenario({ runId, onDone }: ScenarioProps) {
  const [refreshes, setRefreshes] = useState(0);
  useBurst(runId, 6, 150, () => setRefreshes((value) => value + 1), onDone);
  return (
    <View>
      <Text>Refreshes {refreshes}</Text>
      <PriceHistoryChart refreshes={refreshes} />
    </View>
  );
}

function PriceHistoryChart({ refreshes }: { refreshes: number }) {
  const trend = busyWork(1_500_000, refreshes + 1);
  return <Text testID="perf-chart">Trend {trend % 1000}</Text>;
}

// memo-defeated: the rows are memoized, but the list passes a fresh callback and style object.
function MemoDefeatedScenario({ runId, onDone }: ScenarioProps) {
  const [selected, setSelected] = useState(-1);
  useBurst(runId, 6, 150, (index) => setSelected(index), onDone);
  return <ContactList onSelect={setSelected} selected={selected} />;
}

function ContactList({ selected, onSelect }: { selected: number; onSelect: (id: number) => void }) {
  return (
    <ScrollView style={styles.list}>
      {CONTACTS.map((contact) => (
        <ContactRow
          contact={contact}
          highlight={{ opacity: contact.id === selected ? 1 : 0.8 }}
          key={contact.id}
          onSelect={() => onSelect(contact.id)}
        />
      ))}
    </ScrollView>
  );
}

const ContactRow = memo(function ContactRow({
  contact,
  highlight,
  onSelect,
}: {
  contact: Contact;
  highlight: { opacity: number };
  onSelect: () => void;
}) {
  busyWork(20_000, contact.id);
  return (
    <Pressable onPress={onSelect} style={[styles.row, highlight]}>
      <Text>{contact.name}</Text>
    </Pressable>
  );
});

// context-cascade: the context carries a fast-changing `unread` counter next to the stable `user`
// name, so every badge that reads only `user` re-renders on each `unread` change.
type Session = { user: string; unread: number };
const SessionContext = createContext<Session>({ user: 'guest', unread: 0 });

function ContextCascadeScenario({ runId, onDone }: ScenarioProps) {
  const [unread, setUnread] = useState(0);
  useBurst(runId, 6, 150, () => setUnread((value) => value + 1), onDone);
  return (
    <SessionProvider unread={unread}>
      <Text>Unread {unread}</Text>
      <BadgeGrid />
    </SessionProvider>
  );
}

function SessionProvider({ unread, children }: { unread: number; children: ReactNode }) {
  return (
    <SessionContext.Provider value={{ user: 'Ada', unread }}>{children}</SessionContext.Provider>
  );
}

const BadgeGrid = memo(function BadgeGrid() {
  return (
    <View style={styles.grid}>
      {CONTACTS.map((contact) => (
        <AvatarBadge key={contact.id} seed={contact.id} />
      ))}
    </View>
  );
});

function AvatarBadge({ seed }: { seed: number }) {
  const { user } = useContext(SessionContext);
  busyWork(15_000, seed);
  return <Text style={styles.badge}>{user.slice(0, 1)}</Text>;
}

// parent-cascade: typing updates the screen's state and re-renders every unmemoized result row.
function ParentCascadeScenario({ runId, onDone }: ScenarioProps) {
  const [query, setQuery] = useState('');
  useBurst(runId, 8, 100, (index) => setQuery('searching'.slice(0, index + 1)), onDone);
  return <SearchResults onChangeQuery={setQuery} query={query} />;
}

function SearchResults({
  query,
  onChangeQuery,
}: {
  query: string;
  onChangeQuery: (value: string) => void;
}) {
  return (
    <View>
      <TextInput
        onChangeText={onChangeQuery}
        style={styles.input}
        testID="perf-search"
        value={query}
      />
      <ScrollView style={styles.list}>
        {CONTACTS.map((contact) => (
          <ResultRow contact={contact} key={contact.id} />
        ))}
      </ScrollView>
    </View>
  );
}

function ResultRow({ contact }: { contact: Contact }) {
  busyWork(15_000, contact.id);
  return (
    <View style={styles.row}>
      <Text>{contact.name}</Text>
    </View>
  );
}

const MemoResultRow = memo(ResultRow);

// render-storm: a clock drives React state from a 16 ms timer, committing every frame.
function RenderStormScenario({ runId, onDone }: ScenarioProps) {
  return <LiveClock onDone={onDone} runId={runId} />;
}

function LiveClock({ runId, onDone }: ScenarioProps) {
  const [now, setNow] = useState(0);
  useBurst(runId, 90, 16, () => setNow(Date.now()), onDone);
  return <Text testID="perf-clock">{now % 100_000}</Text>;
}

// effect-chain: derived state is copied in an effect, so every change commits twice.
function EffectChainScenario({ runId, onDone }: ScenarioProps) {
  const [items, setItems] = useState(() => CONTACTS.slice(0, 20));
  useBurst(runId, 6, 150, (index) => setItems(CONTACTS.slice(index, index + 20)), onDone);
  return <FilteredContacts items={items} />;
}

function FilteredContacts({ items }: { items: Contact[] }) {
  const [visible, setVisible] = useState<Contact[]>([]);
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- the seeded effect-chain problem
    setVisible(items.filter((contact) => contact.id % 2 === 0));
  }, [items]);
  return (
    <View>
      {visible.map((contact) => (
        <MemoResultRow contact={contact} key={contact.id} />
      ))}
    </View>
  );
}

// eager-list: showing the catalog mounts every tile at once instead of virtualizing the list.
function EagerListScenario({ runId, onDone }: ScenarioProps) {
  const [mountedRun, setMountedRun] = useState(0);
  useBurst(runId, 1, 50, () => setMountedRun(runId), onDone);
  return (
    <ScrollView style={styles.list}>
      {runId > 0 && mountedRun === runId
        ? CATALOG.map((id) => <ProductTile id={id} key={id} />)
        : null}
    </ScrollView>
  );
}

function ProductTile({ id }: { id: number }) {
  return (
    <View style={styles.tile}>
      <Text>Product {id}</Text>
      <Text>{(id * 7) % 100} in stock</Text>
    </View>
  );
}

type Contact = { id: number; name: string };

const CONTACTS: Contact[] = Array.from({ length: 60 }, (_, id) => ({ id, name: `Contact ${id}` }));
const CATALOG = Array.from({ length: 1200 }, (_, id) => id);

const styles = StyleSheet.create({
  frame: { flex: 1, padding: 16, paddingTop: 48, gap: 8 },
  title: { fontSize: 20, fontWeight: '600' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#999',
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  chipSelected: { backgroundColor: '#dde8ff' },
  chipLabel: { fontSize: 12 },
  toolbar: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  run: { backgroundColor: '#2f5bd3', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8 },
  runLabel: { color: 'white', fontWeight: '600' },
  list: { flexGrow: 0, maxHeight: 420 },
  row: { paddingVertical: 4 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 4 },
  badge: { width: 24, textAlign: 'center' },
  input: { borderWidth: 1, borderColor: '#999', borderRadius: 6, padding: 6 },
  tile: { paddingVertical: 2 },
});
