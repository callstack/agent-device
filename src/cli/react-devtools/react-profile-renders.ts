import {
  COMPONENT_KINDS,
  componentKind,
  splitDisplayName,
  type ComponentKind,
} from './react-component.ts';

/** Frame budget at 60 Hz; a commit slower than this drops at least one frame. */
export const FRAME_BUDGET_MS = 16;

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

/**
 * The name findings and tables use. An `Animated(...)` wrapper keeps its full name: it is a separate
 * framework component that renders the inner one, and `isFrameworkPrimitive` recognizes it by it.
 */
function renderName(displayName: string): { name: string; wrappers: string[] } {
  const split = splitDisplayName(displayName);
  return split.wrappers.includes('Animated') ? { ...split, name: displayName } : split;
}

export function isFrameworkPrimitive(name: string): boolean {
  const { name: inner, wrappers } = splitDisplayName(name);
  return FRAMEWORK_PRIMITIVES.has(inner) || wrappers.includes('Animated');
}

const CHANGE_CONTEXT = 1;
const CHANGE_HOOKS = 2;

/** `[name, elementType, ownerId, parentId, key]` as recorded from the backend's tree operations. */
type RawProfileElement = [string, number, number, number, (string | null)?];
/** `1` marks a first mount; otherwise `[bits, propKeyIndexes, stateKeyIndexes, hookIndexes]`. */
export type RawProfileChange = 1 | [number, number[] | null, number[] | null, number[] | null];

export type RawProfileCommit = {
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

/** A component as the profile can tell it apart: `Row` and memo-wrapped `Row` are two components. */
export type ComponentId = { name: string; kind: ComponentKind };

export function componentKey(component: ComponentId): string {
  return `${component.name}\0${component.kind}`;
}

export function sameComponent(a: ComponentId, b: ComponentId): boolean {
  return a.name === b.name && a.kind === b.kind;
}

export type RenderCauses = {
  mount: number;
  props: number;
  state: number;
  hooks: number;
  context: number;
  /** Rendered with the same props, state, hooks, and context: only its parent rendering forced it. */
  parent: number;
};

export type ComponentProfile = ComponentId & {
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
  /** Commits where this component spent the most self time, costliest first, capped. */
  costliestCommits: Array<{ index: number; selfMs: number }>;
};

export type CommitComponent = ComponentId & {
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
  updaters: ComponentId[];
  /** Every component that rendered in this commit, largest self time first. */
  components: CommitComponent[];
};

/** Mounted instance to inspect, per component name, for the value kinds of its changed props. */
type PropKindRequest = Record<string, string[]>;
export type PropKindsById = Record<string, Record<string, string>>;

const COMPONENT_COMMIT_LIMIT = 5;
const RECENT_INSTANCE_LIMIT = 3;
const PROP_KIND_CANDIDATES = 8;

type ComponentAccumulator = ComponentProfile & {
  ids: Set<number>;
  /** Most recently rendered instances, newest last, so at least one is likely still mounted. */
  recentIds: number[];
  commitCosts: Map<number, number>;
};

type ParsedRender = ComponentId & {
  id: number;
  actualMs: number;
  selfMs: number;
  causes: string[];
};

/** Undefined when the profile could not name the element; such renders stay out of the analysis. */
function elementOf(profile: RawReactProfile, id: number): RawProfileElement | undefined {
  return profile.elements[String(id)];
}

function componentOf(element: RawProfileElement): ComponentId {
  const { name, wrappers } = renderName(element[0]);
  return { name, kind: wrappers.includes('Memo') ? 'memo' : componentKind(element[1]) };
}

/** The distinct components behind these elements, leaving out any the profile could not name. */
export function componentsOf(profile: RawReactProfile, ids: number[]): ComponentId[] {
  const components = new Map<string, ComponentId>();
  for (const id of ids) {
    const element = elementOf(profile, id);
    if (!element) continue;
    const component = componentOf(element);
    components.set(componentKey(component), component);
  }
  return [...components.values()];
}

/** The element that contains `id` in the tree, when the profile recorded it. */
export function parentOf(profile: RawReactProfile, id: number): number | undefined {
  return elementOf(profile, id)?.[3] || undefined;
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
    const element = elementOf(profile, id);
    if (!element || !Object.hasOwn(COMPONENT_KINDS, element[1])) continue;
    yield {
      ...componentOf(element),
      id,
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
    kind: render.kind,
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
    costliestCommits: [],
    ids: new Set(),
    recentIds: [],
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
  entry.recentIds = [...entry.recentIds.filter((id) => id !== render.id), render.id].slice(
    -RECENT_INSTANCE_LIMIT,
  );
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
  const ownerId = elementOf(profile, render.id)?.[2];
  const owner = ownerId ? elementOf(profile, ownerId) : undefined;
  if (owner) bump(entry.owners, componentOf(owner).name);
}

function accumulateComponents(profile: RawReactProfile): Map<string, ComponentAccumulator> {
  const components = new Map<string, ComponentAccumulator>();
  profile.commits.forEach((commit, commitIndex) => {
    for (const render of commitRenders(profile, commit)) {
      const key = componentKey(render);
      let entry = components.get(key);
      if (!entry) {
        entry = createAccumulator(render);
        components.set(key, entry);
      }
      recordRender(entry, render, profile, commit, commitIndex);
    }
  });
  for (const entry of components.values()) {
    entry.instances = entry.ids.size;
    entry.costliestCommits = [...entry.commitCosts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, COMPONENT_COMMIT_LIMIT)
      .map(([index, selfMs]) => ({ index, selfMs }));
  }
  return components;
}

/**
 * Picks the components whose changed props are worth classifying by value kind: those that
 * re-rendered mostly because props changed. The host asks the app to inspect their most recent
 * instances, any of which may still be mounted, before analysis.
 */
export function selectPropKindRequests(profile: RawReactProfile): PropKindRequest {
  const candidates = [...accumulateComponents(chronological(profile)).values()]
    .filter((entry) => entry.causes.props > 0 && Object.keys(entry.changedProps).length > 0)
    .sort((a, b) => b.selfMs - a.selfMs)
    .slice(0, PROP_KIND_CANDIDATES);
  const request: PropKindRequest = {};
  for (const entry of candidates) {
    for (const id of entry.recentIds) request[String(id)] = Object.keys(entry.changedProps);
  }
  return request;
}

function summarizeCommits(profile: RawReactProfile): CommitProfile[] {
  const origin = profile.commits[0]?.timestamp ?? 0;
  return profile.commits.map((commit, index) => {
    const byComponent = new Map<string, CommitComponent>();
    let rendered = 0;
    let mounts = 0;
    for (const render of commitRenders(profile, commit)) {
      rendered += 1;
      if (render.causes.includes('mount')) mounts += 1;
      const key = componentKey(render);
      const entry = byComponent.get(key) ?? {
        name: render.name,
        kind: render.kind,
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
      byComponent.set(key, entry);
    }
    return {
      index,
      atMs: Math.round(commit.timestamp - origin),
      durationMs: commit.duration,
      rendered,
      mounts,
      updaters: componentsOf(profile, commit.updaters),
      components: [...byComponent.values()].sort((a, b) => b.selfMs - a.selfMs),
    };
  });
}

export const formatMs = (value: number) => `${value.toFixed(value >= 10 ? 0 : 1)}ms`;

/** Each root records its own commit list; the analysis reads them as one timeline. */
export function chronological(profile: RawReactProfile): RawReactProfile {
  return { ...profile, commits: [...profile.commits].sort((a, b) => a.timestamp - b.timestamp) };
}

/** Each prop's kind where every inspected instance agrees; a prop whose instances disagree has none. */
function commonPropKinds(ids: Set<number>, propKindsById: PropKindsById): Record<string, string> {
  const kinds: Record<string, string> = {};
  const conflicting = new Set<string>();
  for (const id of ids) {
    for (const [key, kind] of Object.entries(propKindsById[String(id)] ?? {})) {
      if (kinds[key] !== undefined && kinds[key] !== kind) conflicting.add(key);
      else kinds[key] = kind;
    }
  }
  for (const key of conflicting) delete kinds[key];
  return kinds;
}

/** Per-component render totals and per-commit summaries of a chronological profile. */
export function summarizeRenders(
  profile: RawReactProfile,
  propKindsById: PropKindsById = {},
): { components: ComponentProfile[]; commits: CommitProfile[] } {
  const accumulators = accumulateComponents(profile);
  for (const entry of accumulators.values())
    entry.propKinds = commonPropKinds(entry.ids, propKindsById);
  const components: ComponentProfile[] = [...accumulators.values()]
    .map(({ ids: _ids, recentIds: _recentIds, commitCosts: _commitCosts, ...entry }) => entry)
    .sort((a, b) => b.selfMs - a.selfMs);
  return { components, commits: summarizeCommits(profile) };
}
