import {
  bump,
  chronological,
  commitRenders,
  componentName,
  formatMs,
  FRAME_BUDGET_MS,
  isFrameworkPrimitive,
  summarizeRenders,
  type CommitComponent,
  type CommitProfile,
  type ComponentProfile,
  type PropKindsById,
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
  /** Estimated render time the pattern cost during the profile. */
  costMs: number;
  evidence: string;
  fix: string;
};

export type ReactProfileAnalysis = {
  version: 1;
  wallMs: number;
  commitCount: number;
  renderMs: number;
  slowCommitCount: number;
  worstCommit: { index: number; durationMs: number } | null;
  naming: RawReactProfile['naming'];
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
    component: entry.name,
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
  const keys = unstable.map((key) =>
    entry.propKinds[key] ? `${key} (${entry.propKinds[key]})` : key,
  );
  const owner = topOwner(entry);
  return {
    kind: 'memo-defeated',
    component: entry.name,
    costMs: costShare(entry, entry.causes.props),
    evidence: `memo bypassed on ${entry.causes.props}/${updates} updates; new ${keys.join(', ')} every render${owner ? ` from ${owner}` : ''}`,
    fix: `wrap those props in useCallback/useMemo${owner ? ` in ${owner}` : ''}`,
  };
}

function contextCascadeFinding(entry: ComponentProfile, triggers: string[]): Finding | null {
  const updates = entry.renders - entry.causes.mount;
  if (updates < 10 || entry.causes.context < updates * 0.5) return null;
  return {
    kind: 'context-cascade',
    component: entry.name,
    costMs: costShare(entry, entry.causes.context),
    evidence: `${entry.causes.context} context-driven renders${instancesNote(entry)}${triggers.length ? ` after updates in ${triggers.join(', ')}` : ''}`,
    fix: 'memoize the provider value or split the context',
  };
}

function parentCascadeFinding(entry: ComponentProfile): Finding | null {
  const updates = entry.renders - entry.causes.mount;
  if (entry.kind === 'memo' || updates < 10 || entry.causes.parent < updates * 0.5) return null;
  const owner = topOwner(entry);
  return {
    kind: 'parent-cascade',
    component: entry.name,
    costMs: costShare(entry, entry.causes.parent),
    evidence: `${entry.causes.parent}/${updates} re-renders with unchanged props, state, and context${owner ? ` whenever ${owner} rendered` : ''}${instancesNote(entry)}`,
    fix: `wrap ${entry.name} in React.memo or move state below ${owner ?? 'its parent'}`,
  };
}

/** Commit that renders more than this many instances of one component at mount is eager. */
const EAGER_MOUNT_INSTANCES = 200;

function eagerMountFindings(profile: RawReactProfile, commits: CommitProfile[]): Finding[] {
  const findings = new Map<string, Finding>();
  profile.commits.forEach((commit, index) => {
    const mounts = new Map<string, number>();
    let total = 0;
    for (const render of commitRenders(profile, commit)) {
      if (!render.causes.includes('mount')) continue;
      total += 1;
      if (!isFrameworkPrimitive(render.name))
        mounts.set(render.name, (mounts.get(render.name) ?? 0) + 1);
    }
    const [name, count] = [...mounts.entries()].sort((a, b) => b[1] - a[1])[0] ?? [];
    if (!name || !count || count < EAGER_MOUNT_INSTANCES || findings.has(name)) return;
    const durationMs = commits[index]!.durationMs;
    findings.set(name, {
      kind: 'eager-mount',
      component: name,
      costMs: durationMs,
      evidence: `${count} instances mounted at once in commit #${index} (${total} components, ${ms(durationMs)})`,
      fix: 'virtualize the list (FlatList/FlashList)',
    });
  });
  return [...findings.values()];
}

/**
 * A follow-up commit that starts within a frame of the previous one, triggered by a component that
 * rendered in it but did not trigger it, came from that component's own effect.
 */
const CHAINED_COMMIT_GAP_MS = FRAME_BUDGET_MS;

function effectChainFindings(profile: RawReactProfile): Finding[] {
  const chains = new Map<string, { count: number; costMs: number }>();
  for (let index = 1; index < profile.commits.length; index += 1) {
    const previous = profile.commits[index - 1]!;
    const commit = profile.commits[index]!;
    const gap = commit.timestamp - commit.duration - previous.timestamp;
    if (gap > CHAINED_COMMIT_GAP_MS) continue;
    const renderedBefore = new Set(previous.fibers.filter((_, offset) => offset % 3 === 0));
    const triggeredBefore = new Set(previous.updaters);
    for (const updater of new Set(commit.updaters)) {
      if (!renderedBefore.has(updater) || triggeredBefore.has(updater)) continue;
      const name = componentName(profile, updater);
      if (isFrameworkPrimitive(name)) continue;
      const chain = chains.get(name) ?? { count: 0, costMs: 0 };
      chain.count += 1;
      chain.costMs += commit.duration;
      chains.set(name, chain);
    }
  }
  return [...chains.entries()]
    .filter(([, chain]) => chain.count >= 3)
    .map(([name, chain]) => ({
      kind: 'effect-chain' as const,
      component: name,
      costMs: chain.costMs,
      evidence: `${plural(chain.count, 'extra commit')} right after it rendered (${ms(chain.costMs)})`,
      fix: 'compute the value during render (useMemo) instead of effect + setState',
    }));
}

const STORM_MIN_COMMITS = 20;
const STORM_MIN_RATE_PER_SECOND = 20;

function renderStormFindings(profile: RawReactProfile): Finding[] {
  const byUpdater = new Map<string, number[]>();
  profile.commits.forEach((commit, index) => {
    for (const name of new Set(commit.updaters.map((id) => componentName(profile, id)))) {
      const indexes = byUpdater.get(name) ?? [];
      indexes.push(index);
      byUpdater.set(name, indexes);
    }
  });
  const findings: Finding[] = [];
  for (const [name, indexes] of byUpdater) {
    if (indexes.length < STORM_MIN_COMMITS || isFrameworkPrimitive(name)) continue;
    const first = profile.commits[indexes[0]!]!.timestamp;
    const last = profile.commits[indexes.at(-1)!]!.timestamp;
    const spanSeconds = Math.max((last - first) / 1000, 0.001);
    const rate = (indexes.length - 1) / spanSeconds;
    if (rate < STORM_MIN_RATE_PER_SECOND) continue;
    const costMs = indexes.reduce((sum, index) => sum + profile.commits[index]!.duration, 0);
    findings.push({
      kind: 'render-storm',
      component: name,
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

/** Render time in a commit that earlier findings already account for. */
function explainedMs(commit: CommitProfile, earlier: Finding[]): number {
  const bySelf = new Set(
    earlier.filter((f) => SELF_COST_FINDINGS.has(f.kind)).map((f) => f.component),
  );
  const bySubtree = new Set(
    earlier.filter((f) => !SELF_COST_FINDINGS.has(f.kind)).map((f) => f.component),
  );
  let total = 0;
  for (const entry of commit.top) {
    if (bySubtree.has(entry.name)) total += entry.actualMs;
    else if (bySelf.has(entry.name)) total += entry.selfMs;
  }
  return total;
}

/** The app component to cut work under: the updater when it holds the commit, else the deepest holder. */
function subtreeOwner(commit: CommitProfile): CommitComponent | undefined {
  const covering = commit.top.filter(
    (entry) =>
      !isFrameworkPrimitive(entry.name) && entry.actualMs >= commit.durationMs * SUBTREE_SHARE,
  );
  return (
    covering.find((entry) => commit.updaters.includes(entry.name)) ??
    covering.sort((a, b) => a.actualMs - b.actualMs)[0]
  );
}

function slowCommitFinding(commit: CommitProfile): Finding {
  const owner = subtreeOwner(commit);
  const heaviest = [...commit.top]
    .sort((a, b) => b.selfMs - a.selfMs)
    .slice(0, 3)
    .map(
      (entry) =>
        `${entry.name}${entry.instances > 1 ? ` x${entry.instances}` : ''} ${ms(entry.selfMs)}`,
    );
  const mounted = commit.mounts > 0 ? ` (${commit.mounts} mounted)` : '';
  const inside = owner && !commit.updaters.includes(owner.name) ? ` inside ${owner.name}` : '';
  const trigger = commit.updaters.length > 0 ? ` after ${commit.updaters.join(', ')} updated` : '';
  return {
    kind: 'slow-commit',
    component: owner?.name ?? commit.updaters[0] ?? `#${commit.index}`,
    costMs: commit.durationMs,
    evidence: `commit #${commit.index} took ${ms(commit.durationMs)} rendering ${commit.rendered} components${mounted}${inside}${trigger}; most time in ${heaviest.join(', ')}`,
    fix: `render less ${owner ? `under ${owner.name} ` : ''}per update (memoize, virtualize, or defer)`,
  };
}

function slowCommitFindings(commits: CommitProfile[], earlier: Finding[]): Finding[] {
  return commits
    .filter((commit) => commit.durationMs >= SLOW_COMMIT_MS)
    .filter((commit) => explainedMs(commit, earlier) < commit.durationMs * EXPLAINED_SHARE)
    .sort((a, b) => b.durationMs - a.durationMs)
    .slice(0, SLOW_COMMIT_FINDING_LIMIT)
    .map(slowCommitFinding);
}

function contextTriggers(profile: RawReactProfile, name: string): string[] {
  const triggers: Record<string, number> = {};
  for (const commit of profile.commits) {
    let contextRender = false;
    for (const render of commitRenders(profile, commit)) {
      if (render.name === name && render.causes.includes('context')) {
        contextRender = true;
        break;
      }
    }
    if (!contextRender) continue;
    for (const id of new Set(commit.updaters)) bump(triggers, componentName(profile, id));
  }
  return topKeys(triggers, 1).slice(0, 2);
}

export function analyzeReactProfile(
  recorded: RawReactProfile,
  propKindsById: PropKindsById = {},
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
      contextCascadeFinding(
        entry,
        entry.causes.context > 0 ? contextTriggers(profile, entry.name) : [],
      ),
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
  findings.push(...slowCommitFindings(commits, findings));
  const renderMs = commits.reduce((sum, commit) => sum + commit.durationMs, 0);
  const costFloorMs = Math.max(MIN_FINDING_COST_MS, renderMs * MIN_FINDING_COST_SHARE);
  const significant = findings
    .filter((finding) => finding.costMs >= costFloorMs)
    .sort((a, b) => b.costMs - a.costMs);

  return {
    version: 1,
    wallMs: profile.stoppedAt - profile.startedAt,
    commitCount: commits.length,
    renderMs,
    slowCommitCount: slowCommits.length,
    worstCommit: worst ? { index: worst.index, durationMs: worst.durationMs } : null,
    naming: profile.naming,
    components,
    commits,
    findings: significant,
  };
}
