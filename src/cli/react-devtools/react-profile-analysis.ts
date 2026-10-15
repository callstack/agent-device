import {
  bump,
  chronological,
  commitRenders,
  componentKey,
  componentsOf,
  formatMs,
  FRAME_BUDGET_MS,
  isFrameworkPrimitive,
  parentOf,
  sameComponent,
  summarizeRenders,
  type CommitComponent,
  type CommitProfile,
  type ComponentId,
  type ComponentKind,
  type ComponentProfile,
  type PropKindsById,
  type RawProfileCommit,
  type RawReactProfile,
} from './react-profile-renders.ts';

export type FindingKind =
  | 'slow-commit'
  | 'slow-render'
  | 'eager-mount'
  | 'memo-defeated'
  | 'context-cascade'
  | 'parent-cascade'
  | 'effect-chain'
  | 'render-storm';

export type Finding = {
  kind: FindingKind;
  component: string;
  /** Absent only for a slow commit that no app component accounts for. */
  componentKind?: ComponentKind;
  /** Estimated render time the pattern cost during the profile. */
  costMs: number;
  evidence: string;
  fix: string;
};

export type ReactProfileAnalysis = {
  wallMs: number;
  commitCount: number;
  renderMs: number;
  slowCommitCount: number;
  worstCommit: { index: number; durationMs: number } | null;
  naming: RawReactProfile['naming'];
  /** Gaps in the evidence behind the findings, such as uninspected prop values. */
  notes: string[];
  components: ComponentProfile[];
  commits: CommitProfile[];
  findings: Finding[];
};

/** Findings cheaper than this, or than this share of all render time, are noise. */
const MIN_FINDING_COST_MS = 2;
const MIN_FINDING_COST_SHARE = 0.03;

function topKeys(record: Record<string, number>, minimum: number): string[] {
  return Object.entries(record)
    .filter(([, count]) => count >= minimum)
    .sort((a, b) => b[1] - a[1])
    .map(([key]) => key);
}

function topOwner(entry: ComponentProfile): string | undefined {
  return topKeys(entry.owners, 1)[0];
}

function costShare(entry: ComponentProfile, renders: number): number {
  return entry.renders === 0 ? 0 : (entry.selfMs * renders) / entry.renders;
}

const ms = formatMs;

function about(component: ComponentId): Pick<Finding, 'component' | 'componentKind'> {
  return { component: component.name, componentKind: component.kind };
}

export function isFindingFor(finding: Finding, component: ComponentId): boolean {
  return (
    finding.componentKind !== undefined &&
    sameComponent({ name: finding.component, kind: finding.componentKind }, component)
  );
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function instancesNote(entry: ComponentProfile): string {
  return entry.instances > 1 ? ` across ${entry.instances} instances` : '';
}

function slowRenderFinding(entry: ComponentProfile): Finding | null {
  const avg = entry.selfMs / entry.renders;
  if (entry.selfMs < FRAME_BUDGET_MS * 2 || (avg < 4 && entry.maxSelfMs < FRAME_BUDGET_MS))
    return null;
  if (entry.instances > 20 && avg < 4) return null;
  return {
    kind: 'slow-render',
    ...about(entry),
    costMs: entry.selfMs,
    evidence: `${ms(avg)} per render (max ${ms(entry.maxSelfMs)}), ${plural(entry.renders, 'render')}${instancesNote(entry)}`,
    fix: 'memoize or move the expensive work out of render',
  };
}

/** Prop value kinds whose change is a real value change rather than a new identity per render. */
const VALUE_KINDS = new Set([
  'boolean',
  'number',
  'string',
  'null',
  'undefined',
  'bigint',
  'symbol',
]);

function memoDefeatedFinding(entry: ComponentProfile): Finding | null {
  const updates = entry.renders - entry.causes.mount;
  if (entry.kind !== 'memo' || updates < 10 || entry.causes.props < updates * 0.5) return null;
  const frequent = topKeys(entry.changedProps, Math.ceil(entry.causes.props * 0.8));
  const candidates = frequent.length > 0 ? frequent : topKeys(entry.changedProps, 1).slice(0, 3);
  const unstable = candidates.filter((key) => !VALUE_KINDS.has(entry.propKinds[key] ?? ''));
  if (unstable.length === 0) return null;
  const owner = topOwner(entry);
  const from = owner ? ` from ${owner}` : '';
  const inOwner = owner ? ` in ${owner}` : '';
  const identities = unstable.filter((key) => entry.propKinds[key] !== undefined);
  const changes = (key: string) => `${entry.changedProps[key]}x`;
  if (identities.length === 0) {
    return {
      kind: 'memo-defeated',
      ...about(entry),
      costMs: costShare(entry, entry.causes.props),
      evidence: `memo bypassed on ${entry.causes.props}/${updates} updates; changed ${unstable.map((key) => `${key} ${changes(key)}`).join(', ')}${from} (value kinds not inspected)`,
      fix: `check whether those props are recreated on each render${inOwner}; stabilize them with useCallback/useMemo`,
    };
  }
  return {
    kind: 'memo-defeated',
    ...about(entry),
    costMs: costShare(entry, entry.causes.props),
    evidence: `memo bypassed on ${entry.causes.props}/${updates} updates; new ${identities.map((key) => `${key} (${entry.propKinds[key]}) ${changes(key)}`).join(', ')}${from}`,
    fix: `wrap those props in useCallback/useMemo${inOwner}`,
  };
}

function contextCascadeFinding(entry: ComponentProfile, triggers: string[]): Finding | null {
  const updates = entry.renders - entry.causes.mount;
  if (updates < 10 || entry.causes.context < updates * 0.5) return null;
  return {
    kind: 'context-cascade',
    ...about(entry),
    costMs: costShare(entry, entry.causes.context),
    evidence: `${entry.causes.context} context-driven renders${instancesNote(entry)}${triggers.length ? ` after updates in ${triggers.join(', ')}` : ''}`,
    fix: 'split the context so consumers subscribe only to what they read, or memoize the provider value',
  };
}

function parentCascadeFinding(entry: ComponentProfile): Finding | null {
  const updates = entry.renders - entry.causes.mount;
  if (entry.kind === 'memo' || updates < 10 || entry.causes.parent < updates * 0.5) return null;
  const owner = topOwner(entry);
  return {
    kind: 'parent-cascade',
    ...about(entry),
    costMs: costShare(entry, entry.causes.parent),
    evidence: `${entry.causes.parent}/${updates} re-renders with unchanged props, state, and context${owner ? ` when ${owner} rendered` : ''}${instancesNote(entry)}`,
    fix: `wrap ${entry.name} in React.memo or move state below ${owner ?? 'its parent'}`,
  };
}

/** Commit that renders more than this many instances of one component at mount is eager. */
const EAGER_MOUNT_INSTANCES = 200;

type EagerMount = {
  index: number;
  count: number;
  costMs: number;
  durationMs: number;
  mounted: number;
};

function eagerMountFindings(profile: RawReactProfile, commits: CommitProfile[]): Finding[] {
  const mountsByComponent = new Map<string, { component: ComponentId; mounts: EagerMount[] }>();
  profile.commits.forEach((commit, index) => {
    const groups = new Map<string, { component: ComponentId; count: number; actualMs: number }>();
    let mounted = 0;
    for (const render of commitRenders(profile, commit)) {
      if (!render.causes.includes('mount')) continue;
      mounted += 1;
      if (isFrameworkPrimitive(render.name)) continue;
      const key = componentKey(render);
      const group = groups.get(key) ?? { component: render, count: 0, actualMs: 0 };
      group.count += 1;
      group.actualMs += render.actualMs;
      groups.set(key, group);
    }
    const durationMs = commits[index]!.durationMs;
    for (const [key, group] of groups) {
      if (group.count < EAGER_MOUNT_INSTANCES) continue;
      const costMs = Math.min(group.actualMs, durationMs);
      const entry = mountsByComponent.get(key) ?? { component: group.component, mounts: [] };
      entry.mounts.push({ index, count: group.count, costMs, durationMs, mounted });
      mountsByComponent.set(key, entry);
    }
  });
  return [...mountsByComponent.values()].map(({ component, mounts }) => {
    const worst = mounts.reduce((a, b) => (b.costMs > a.costMs ? b : a));
    const costMs = mounts.reduce((sum, mount) => sum + mount.costMs, 0);
    const repeated =
      mounts.length > 1 ? `; ${mounts.length} such commits, ${ms(costMs)} in all` : '';
    return {
      kind: 'eager-mount' as const,
      ...about(component),
      costMs,
      evidence: `${worst.count} instances mounted at once in commit #${worst.index}, ${ms(worst.costMs)} of its ${ms(worst.durationMs)} (${worst.mounted} components mounted)${repeated}`,
      fix: 'virtualize the list (FlatList/FlashList)',
    };
  });
}

/**
 * A follow-up commit that starts within a frame of the previous one, triggered by a component that
 * rendered in it but did not trigger it, most likely came from that component's own effect. The
 * profile records no effect provenance, so the finding is worded as a likely cause.
 */
const CHAINED_COMMIT_GAP_MS = FRAME_BUDGET_MS;

/** App components that rendered in `previous` without triggering it, then triggered `commit`. */
function chainedUpdaters(
  profile: RawReactProfile,
  previous: RawProfileCommit,
  commit: RawProfileCommit,
): ComponentId[] {
  const renderedBefore = new Set(previous.fibers.filter((_, offset) => offset % 3 === 0));
  const triggeredBefore = new Set(previous.updaters);
  const chained = commit.updaters.filter(
    (updater) => renderedBefore.has(updater) && !triggeredBefore.has(updater),
  );
  return componentsOf(profile, chained).filter((updater) => !isFrameworkPrimitive(updater.name));
}

function effectChainFindings(profile: RawReactProfile): Finding[] {
  const chains = new Map<string, { component: ComponentId; count: number; costMs: number }>();
  for (let index = 1; index < profile.commits.length; index += 1) {
    const previous = profile.commits[index - 1]!;
    const commit = profile.commits[index]!;
    const gap = commit.timestamp - commit.duration - previous.timestamp;
    if (gap > CHAINED_COMMIT_GAP_MS) continue;
    for (const updater of chainedUpdaters(profile, previous, commit)) {
      const key = componentKey(updater);
      const chain = chains.get(key) ?? { component: updater, count: 0, costMs: 0 };
      chain.count += 1;
      chain.costMs += commit.duration;
      chains.set(key, chain);
    }
  }
  return [...chains.values()]
    .filter((chain) => chain.count >= 3)
    .map((chain) => ({
      kind: 'effect-chain' as const,
      ...about(chain.component),
      costMs: chain.costMs,
      evidence: `${plural(chain.count, 'follow-up commit')} it triggered right after rendering, likely state set in an effect (${ms(chain.costMs)})`,
      fix: 'if an effect copies derived state, compute it during render (useMemo) instead',
    }));
}

const STORM_MIN_COMMITS = 20;
const STORM_MIN_RATE_PER_SECOND = 20;

function renderStormFindings(profile: RawReactProfile): Finding[] {
  const byUpdater = new Map<string, { component: ComponentId; indexes: number[] }>();
  profile.commits.forEach((commit, index) => {
    for (const updater of componentsOf(profile, commit.updaters)) {
      const key = componentKey(updater);
      const entry = byUpdater.get(key) ?? { component: updater, indexes: [] };
      entry.indexes.push(index);
      byUpdater.set(key, entry);
    }
  });
  const findings: Finding[] = [];
  for (const { component, indexes } of byUpdater.values()) {
    if (indexes.length < STORM_MIN_COMMITS || isFrameworkPrimitive(component.name)) continue;
    const first = profile.commits[indexes[0]!]!.timestamp;
    const last = profile.commits[indexes.at(-1)!]!.timestamp;
    const spanSeconds = Math.max((last - first) / 1000, 0.001);
    const rate = (indexes.length - 1) / spanSeconds;
    if (rate < STORM_MIN_RATE_PER_SECOND) continue;
    const costMs = indexes.reduce((sum, index) => sum + profile.commits[index]!.duration, 0);
    findings.push({
      kind: 'render-storm',
      ...about(component),
      costMs,
      evidence: `${indexes.length} commits in ${spanSeconds.toFixed(1)}s (${Math.round(rate)}/s, ${ms(costMs)} rendering)`,
      fix: 'throttle the updates or animate outside React state (Animated/Reanimated)',
    });
  }
  return findings;
}

/** A commit at least this slow without a component finding behind it is reported on its own. */
const SLOW_COMMIT_MS = FRAME_BUDGET_MS * 3;
const SLOW_COMMIT_FINDING_LIMIT = 2;
const EXPLAINED_SHARE = 0.5;
/** The app component whose subtree holds this share of a slow commit is where to cut work. */
const SUBTREE_SHARE = 0.8;

/** Findings whose cost lives in the component's own render, versus in the subtree it re-renders. */
const SELF_COST_FINDINGS = new Set<FindingKind>(['slow-render', 'effect-chain', 'render-storm']);

type Explanation = 'self' | 'subtree';

/** What each component's findings account for, by component key: its own render or its subtree. */
function explanations(earlier: Finding[]): Map<string, Explanation> {
  const byComponent = new Map<string, Explanation>();
  for (const finding of earlier) {
    if (finding.componentKind === undefined) continue;
    const key = componentKey({ name: finding.component, kind: finding.componentKind });
    if (!SELF_COST_FINDINGS.has(finding.kind)) byComponent.set(key, 'subtree');
    else if (!byComponent.has(key)) byComponent.set(key, 'self');
  }
  return byComponent;
}

/**
 * Render time in a commit that earlier findings already account for. A subtree finding's time
 * includes every render below it, so renders inside an accounted subtree are not counted again.
 */
function explainedMs(
  profile: RawReactProfile,
  commit: RawProfileCommit,
  explained: Map<string, Explanation>,
): number {
  const renders = [...commitRenders(profile, commit)];
  const accountedSubtrees = new Set(
    renders.filter((render) => explained.get(componentKey(render)) === 'subtree').map((r) => r.id),
  );
  const insideAccounted = (id: number): boolean => {
    const visited = new Set<number>();
    for (
      let parent = parentOf(profile, id);
      parent && !visited.has(parent);
      parent = parentOf(profile, parent)
    ) {
      if (accountedSubtrees.has(parent)) return true;
      visited.add(parent);
    }
    return false;
  };
  let total = 0;
  for (const render of renders) {
    const explanation = explained.get(componentKey(render));
    if (!explanation || insideAccounted(render.id)) continue;
    total += explanation === 'subtree' ? render.actualMs : render.selfMs;
  }
  return total;
}

/** The app component to cut work under: the updater when it holds the commit, else the deepest holder. */
function subtreeOwner(commit: CommitProfile): CommitComponent | undefined {
  const covering = commit.components.filter(
    (entry) =>
      !isFrameworkPrimitive(entry.name) && entry.actualMs >= commit.durationMs * SUBTREE_SHARE,
  );
  return (
    covering.find((entry) => commit.updaters.some((updater) => sameComponent(updater, entry))) ??
    covering.sort((a, b) => a.actualMs - b.actualMs)[0]
  );
}

function slowCommitFinding(commit: CommitProfile): Finding {
  const owner = subtreeOwner(commit);
  const heaviest = commit.components
    .slice(0, 3)
    .map(
      (entry) =>
        `${entry.name}${entry.instances > 1 ? ` x${entry.instances}` : ''} ${ms(entry.selfMs)}`,
    );
  const mounted = commit.mounts > 0 ? ` (${commit.mounts} mounted)` : '';
  const inside =
    owner && !commit.updaters.some((updater) => sameComponent(updater, owner))
      ? ` inside ${owner.name}`
      : '';
  const trigger =
    commit.updaters.length > 0
      ? ` after ${commit.updaters.map((updater) => updater.name).join(', ')} updated`
      : '';
  const component = owner ?? commit.updaters[0];
  return {
    kind: 'slow-commit',
    ...(component ? about(component) : { component: `#${commit.index}` }),
    costMs: commit.durationMs,
    evidence: `commit #${commit.index} took ${ms(commit.durationMs)} rendering ${commit.rendered} components${mounted}${inside}${trigger}; most time in ${heaviest.join(', ')}`,
    fix: `render less ${owner ? `under ${owner.name} ` : ''}per update (memoize, virtualize, or defer)`,
  };
}

function slowCommitFindings(
  profile: RawReactProfile,
  commits: CommitProfile[],
  earlier: Finding[],
): Finding[] {
  const explained = explanations(earlier);
  return commits
    .filter((commit) => commit.durationMs >= SLOW_COMMIT_MS)
    .filter(
      (commit) =>
        explainedMs(profile, profile.commits[commit.index]!, explained) <
        commit.durationMs * EXPLAINED_SHARE,
    )
    .sort((a, b) => b.durationMs - a.durationMs)
    .slice(0, SLOW_COMMIT_FINDING_LIMIT)
    .map(slowCommitFinding);
}

function contextTriggers(profile: RawReactProfile, component: ComponentId): string[] {
  const triggers: Record<string, number> = {};
  for (const commit of profile.commits) {
    let contextRender = false;
    for (const render of commitRenders(profile, commit)) {
      if (sameComponent(render, component) && render.causes.includes('context')) {
        contextRender = true;
        break;
      }
    }
    if (!contextRender) continue;
    for (const updater of componentsOf(profile, commit.updaters)) bump(triggers, updater.name);
  }
  return topKeys(triggers, 1).slice(0, 2);
}

export function analyzeReactProfile(
  recorded: RawReactProfile,
  propKindsById: PropKindsById = {},
  notes: string[] = [],
): ReactProfileAnalysis {
  const profile = chronological(recorded);
  const { components, commits } = summarizeRenders(profile, propKindsById);
  const slowCommits = commits.filter((commit) => commit.durationMs > FRAME_BUDGET_MS);
  const worst = commits.reduce<CommitProfile | null>(
    (current, commit) => (current && current.durationMs >= commit.durationMs ? current : commit),
    null,
  );

  const findings: Finding[] = [];
  for (const entry of components) {
    if (isFrameworkPrimitive(entry.name)) continue;
    const cascades = [
      memoDefeatedFinding(entry),
      contextCascadeFinding(entry, entry.causes.context > 0 ? contextTriggers(profile, entry) : []),
      parentCascadeFinding(entry),
    ].filter((finding): finding is Finding => finding !== null);
    // A cascade explains many cheap renders; only a render that alone overruns a frame is also slow.
    const slow =
      cascades.length === 0 || entry.maxSelfMs >= FRAME_BUDGET_MS ? slowRenderFinding(entry) : null;
    const perComponent = slow ? [slow, ...cascades] : cascades;
    findings.push(...perComponent);
  }
  findings.push(...eagerMountFindings(profile, commits));
  findings.push(...effectChainFindings(profile));
  findings.push(...renderStormFindings(profile));
  findings.push(...slowCommitFindings(profile, commits, findings));
  const renderMs = commits.reduce((sum, commit) => sum + commit.durationMs, 0);
  const costFloorMs = Math.max(MIN_FINDING_COST_MS, renderMs * MIN_FINDING_COST_SHARE);
  const significant = findings
    .filter((finding) => finding.costMs >= costFloorMs)
    .sort((a, b) => b.costMs - a.costMs);

  return {
    wallMs: profile.stoppedAt - profile.startedAt,
    commitCount: commits.length,
    renderMs,
    slowCommitCount: slowCommits.length,
    worstCommit: worst ? { index: worst.index, durationMs: worst.durationMs } : null,
    naming: profile.naming,
    notes,
    components,
    commits,
    findings: significant,
  };
}
