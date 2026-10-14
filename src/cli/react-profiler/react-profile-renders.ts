/** Frame budget at 60 Hz; a commit slower than this drops at least one frame. */
export const FRAME_BUDGET_MS = 16;

const ELEMENT_CLASS = 1;
const ELEMENT_FUNCTION = 5;
const ELEMENT_FORWARD_REF = 6;
const ELEMENT_MEMO = 8;
const ELEMENT_VIRTUAL = 15;
/** Name resolved by lookup, so the backend element type is unknown. */
const ELEMENT_UNKNOWN = 0;
const COMPONENT_TYPES = new Set([
  ELEMENT_CLASS,
  ELEMENT_FUNCTION,
  ELEMENT_FORWARD_REF,
  ELEMENT_MEMO,
  ELEMENT_VIRTUAL,
  ELEMENT_UNKNOWN,
]);

/**
 * React Native building blocks whose renders follow from the app component that renders them.
 * They stay in the tables but never head a finding: the fix belongs in their owner.
 */
const FRAMEWORK_PRIMITIVES = new Set([
  'ActivityIndicator',
  'CellRenderer',
  'FlatList',
  'Image',
  'ImageBackground',
  'InternalTextInput',
  'KeyboardAvoidingView',
  'Modal',
  'Pressable',
  'PressabilityDebugView',
  'RefreshControl',
  'SafeAreaView',
  'ScrollView',
  'SectionList',
  'Switch',
  'Text',
  'TextInput',
  'TouchableHighlight',
  'TouchableOpacity',
  'TouchableWithoutFeedback',
  'View',
  'VirtualizedList',
  'VirtualizedListCellContextProvider',
  'VirtualizedSectionList',
]);

const HOC_PATTERN = /^([A-Za-z0-9_$]+)\((.+)\)$/;

/** Splits `Memo(ForwardRef(Row))` into the component name and its wrappers, as DevTools shows it. */
export function splitDisplayName(displayName: string): { name: string; wrappers: string[] } {
  const wrappers: string[] = [];
  let name = displayName;
  for (let match = HOC_PATTERN.exec(name); match; match = HOC_PATTERN.exec(name)) {
    wrappers.push(match[1]!);
    name = match[2]!;
  }
  return { name, wrappers };
}

export function isFrameworkPrimitive(name: string): boolean {
  const { name: inner, wrappers } = splitDisplayName(name);
  return FRAMEWORK_PRIMITIVES.has(inner) || wrappers.includes('Animated');
}

const CHANGE_CONTEXT = 1;
const CHANGE_HOOKS = 2;

/** `[name, elementType, ownerId, parentId]` as recorded from the backend's tree operations. */
type RawProfileElement = [string, number, number, number];
/** `1` marks a first mount; otherwise `[bits, propKeyIndexes, stateKeyIndexes, hookIndexes]`. */
export type RawProfileChange = 1 | [number, number[] | null, number[] | null, number[] | null];

type RawProfileCommit = {
  timestamp: number;
  duration: number;
  updaters: number[];
  /** Flat `[id, actualMs, selfMs, ...]` triples for every element that rendered. */
  fibers: number[];
  /** Absent entries rendered without a prop, state, hook, or context change; null when unrecorded. */
  changes: Record<string, RawProfileChange> | null;
};

/** Profile exactly as the in-app runtime exports it from `stop()`. */
export type RawReactProfile = {
  startedAt: number;
  stoppedAt: number;
  naming: 'operations' | 'lookup';
  elements: Record<string, RawProfileElement>;
  keys: string[];
  commits: RawProfileCommit[];
};

export type ComponentKind = 'class' | 'function' | 'forwardRef' | 'memo' | 'unknown';

export type RenderCauses = {
  mount: number;
  props: number;
  state: number;
  hooks: number;
  context: number;
  /** Rendered with the same props, state, hooks, and context: only its parent rendering forced it. */
  parent: number;
};

export type ComponentProfile = {
  name: string;
  kind: ComponentKind;
  instances: number;
  renders: number;
  selfMs: number;
  maxSelfMs: number;
  causes: RenderCauses;
  changedProps: Record<string, number>;
  changedState: Record<string, number>;
  changedHooks: Record<string, number>;
  /** Component whose render created this one's elements, by occurrence. */
  owners: Record<string, number>;
  /** Value kind of changed props on a mounted instance at stop: function, object, array, ... */
  propKinds: Record<string, string>;
  /** Commits where this component rendered, slowest first, capped. */
  slowestCommits: number[];
};

export type CommitComponent = {
  name: string;
  instances: number;
  selfMs: number;
  /** Time including descendants, summed over instances. */
  actualMs: number;
  causes: string[];
};

export type CommitProfile = {
  index: number;
  /** Milliseconds since the first commit of the profile. */
  atMs: number;
  durationMs: number;
  rendered: number;
  mounts: number;
  updaters: string[];
  /** Components with the largest self time in this commit, capped. */
  top: CommitComponent[];
};

/** Mounted instance to inspect, per component name, for the value kinds of its changed props. */
type PropKindRequest = Record<string, string[]>;
export type PropKindsById = Record<string, Record<string, string>>;

const COMMIT_TOP_LIMIT = 15;
const COMPONENT_COMMIT_LIMIT = 5;
const PROP_KIND_CANDIDATES = 8;

type ComponentAccumulator = ComponentProfile & {
  ids: Set<number>;
  lastId: number;
  commitCosts: Map<number, number>;
};

type ParsedRender = {
  id: number;
  name: string;
  type: number;
  actualMs: number;
  selfMs: number;
  causes: string[];
};

function componentKind(type: number): ComponentKind {
  switch (type) {
    case ELEMENT_CLASS:
      return 'class';
    case ELEMENT_FUNCTION:
    case ELEMENT_VIRTUAL:
      return 'function';
    case ELEMENT_FORWARD_REF:
      return 'forwardRef';
    case ELEMENT_MEMO:
      return 'memo';
    default:
      return 'unknown';
  }
}

function elementOf(profile: RawReactProfile, id: number): RawProfileElement {
  return profile.elements[String(id)] ?? ['Unknown', ELEMENT_UNKNOWN, 0, 0];
}

export function componentName(profile: RawReactProfile, id: number): string {
  return splitDisplayName(elementOf(profile, id)[0]).name;
}

function keysAt(profile: RawReactProfile, indexes: number[] | null): string[] {
  return (indexes ?? []).map((index) => profile.keys[index] ?? `#${index}`);
}

export function bump(record: Record<string, number>, key: string, by = 1): void {
  record[key] = (record[key] ?? 0) + by;
}

export function* commitRenders(
  profile: RawReactProfile,
  commit: RawProfileCommit,
): Generator<ParsedRender> {
  for (let offset = 0; offset + 2 < commit.fibers.length; offset += 3) {
    const id = commit.fibers[offset]!;
    const [displayName, type] = elementOf(profile, id);
    if (!COMPONENT_TYPES.has(type)) continue;
    const { name, wrappers } = splitDisplayName(displayName);
    yield {
      id,
      name,
      type: wrappers.includes('Memo') ? ELEMENT_MEMO : type,
      actualMs: commit.fibers[offset + 1]!,
      selfMs: commit.fibers[offset + 2]!,
      causes: renderCauses(commit, id),
    };
  }
}

function renderCauses(commit: RawProfileCommit, id: number): string[] {
  if (commit.changes === null) return [];
  const change = commit.changes[String(id)];
  if (change === undefined) return ['parent'];
  if (change === 1) return ['mount'];
  const [bits, props, state, hooks] = change;
  const causes: string[] = [];
  if (props?.length) causes.push('props');
  if (state?.length) causes.push('state');
  if (hooks?.length || (bits & CHANGE_HOOKS) !== 0) causes.push('hooks');
  if ((bits & CHANGE_CONTEXT) !== 0) causes.push('context');
  return causes.length > 0 ? causes : ['parent'];
}

function createAccumulator(render: ParsedRender): ComponentAccumulator {
  return {
    name: render.name,
    kind: componentKind(render.type),
    instances: 0,
    renders: 0,
    selfMs: 0,
    maxSelfMs: 0,
    causes: { mount: 0, props: 0, state: 0, hooks: 0, context: 0, parent: 0 },
    changedProps: {},
    changedState: {},
    changedHooks: {},
    owners: {},
    propKinds: {},
    slowestCommits: [],
    ids: new Set(),
    lastId: render.id,
    commitCosts: new Map(),
  };
}

function recordRender(
  entry: ComponentAccumulator,
  render: ParsedRender,
  profile: RawReactProfile,
  commit: RawProfileCommit,
  commitIndex: number,
): void {
  entry.ids.add(render.id);
  entry.lastId = render.id;
  entry.renders += 1;
  entry.selfMs += render.selfMs;
  entry.maxSelfMs = Math.max(entry.maxSelfMs, render.selfMs);
  entry.commitCosts.set(commitIndex, (entry.commitCosts.get(commitIndex) ?? 0) + render.selfMs);
  for (const cause of render.causes) entry.causes[cause as keyof RenderCauses] += 1;
  const change = commit.changes?.[String(render.id)];
  if (Array.isArray(change)) {
    for (const key of keysAt(profile, change[1])) bump(entry.changedProps, key);
    for (const key of keysAt(profile, change[2])) bump(entry.changedState, key);
    for (const hook of change[3] ?? []) bump(entry.changedHooks, String(hook));
  }
  const ownerId = elementOf(profile, render.id)[2];
  if (ownerId) bump(entry.owners, componentName(profile, ownerId));
}

function accumulateComponents(profile: RawReactProfile): Map<string, ComponentAccumulator> {
  const components = new Map<string, ComponentAccumulator>();
  profile.commits.forEach((commit, commitIndex) => {
    for (const render of commitRenders(profile, commit)) {
      let entry = components.get(render.name);
      if (!entry) {
        entry = createAccumulator(render);
        components.set(render.name, entry);
      }
      recordRender(entry, render, profile, commit, commitIndex);
    }
  });
  for (const entry of components.values()) {
    entry.instances = entry.ids.size;
    entry.slowestCommits = [...entry.commitCosts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, COMPONENT_COMMIT_LIMIT)
      .map(([index]) => index);
  }
  return components;
}

/**
 * Picks the components whose changed props are worth classifying by value kind: those that
 * re-rendered mostly because props changed. The host asks the app to inspect one mounted
 * instance of each before analysis.
 */
export function selectPropKindRequests(profile: RawReactProfile): PropKindRequest {
  const candidates = [...accumulateComponents(chronological(profile)).values()]
    .filter((entry) => entry.causes.props > 0 && Object.keys(entry.changedProps).length > 0)
    .sort((a, b) => b.selfMs - a.selfMs)
    .slice(0, PROP_KIND_CANDIDATES);
  const request: PropKindRequest = {};
  for (const entry of candidates) request[String(entry.lastId)] = Object.keys(entry.changedProps);
  return request;
}

function summarizeCommits(profile: RawReactProfile): CommitProfile[] {
  const origin = profile.commits[0]?.timestamp ?? 0;
  return profile.commits.map((commit, index) => {
    const byName = new Map<string, CommitComponent>();
    let rendered = 0;
    let mounts = 0;
    for (const render of commitRenders(profile, commit)) {
      rendered += 1;
      if (render.causes.includes('mount')) mounts += 1;
      const entry = byName.get(render.name) ?? {
        name: render.name,
        instances: 0,
        selfMs: 0,
        actualMs: 0,
        causes: [],
      };
      entry.instances += 1;
      entry.selfMs += render.selfMs;
      entry.actualMs += render.actualMs;
      for (const cause of render.causes)
        if (!entry.causes.includes(cause)) entry.causes.push(cause);
      byName.set(render.name, entry);
    }
    return {
      index,
      atMs: Math.round(commit.timestamp - origin),
      durationMs: commit.duration,
      rendered,
      mounts,
      updaters: [...new Set(commit.updaters.map((id) => componentName(profile, id)))],
      top: [...byName.values()].sort((a, b) => b.selfMs - a.selfMs).slice(0, COMMIT_TOP_LIMIT),
    };
  });
}

export const formatMs = (value: number) => `${value.toFixed(value >= 10 ? 0 : 1)}ms`;

/** Each root records its own commit list; the analysis reads them as one timeline. */
export function chronological(profile: RawReactProfile): RawReactProfile {
  return { ...profile, commits: [...profile.commits].sort((a, b) => a.timestamp - b.timestamp) };
}

/** Per-component render totals and per-commit summaries of a chronological profile. */
export function summarizeRenders(
  profile: RawReactProfile,
  propKindsById: PropKindsById = {},
): { components: ComponentProfile[]; commits: CommitProfile[] } {
  const accumulators = accumulateComponents(profile);
  for (const entry of accumulators.values()) {
    for (const id of entry.ids) Object.assign(entry.propKinds, propKindsById[String(id)] ?? {});
  }
  const components: ComponentProfile[] = [...accumulators.values()]
    .map(({ ids: _ids, lastId: _lastId, commitCosts: _commitCosts, ...entry }) => entry)
    .sort((a, b) => b.selfMs - a.selfMs);
  return { components, commits: summarizeCommits(profile) };
}
