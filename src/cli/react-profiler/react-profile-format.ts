import type { ReactProfileAnalysis } from './react-profile-analysis.ts';
import {
  FRAME_BUDGET_MS,
  formatMs,
  type CommitProfile,
  type ComponentProfile,
  type RenderCauses,
} from './react-profile-renders.ts';

export const DEFAULT_FINDING_LIMIT = 5;

const ms = formatMs;
export const formatSeconds = (value: number) => `${(value / 1000).toFixed(1)}s`;
const seconds = formatSeconds;

function headline(analysis: ReactProfileAnalysis): string {
  const parts = [
    `React profile ${seconds(analysis.wallMs)}: ${analysis.commitCount} commits, ${ms(analysis.renderMs)} rendering`,
  ];
  if (analysis.worstCommit && analysis.slowCommitCount > 0) {
    parts.push(
      `${analysis.slowCommitCount} over ${FRAME_BUDGET_MS}ms (worst #${analysis.worstCommit.index} ${ms(analysis.worstCommit.durationMs)})`,
    );
  }
  return parts.join(', ');
}

export function formatProfileSummary(
  analysis: ReactProfileAnalysis,
  limit = DEFAULT_FINDING_LIMIT,
): string {
  if (analysis.commitCount === 0) {
    return 'React profile: no commits recorded. Start profiling, then perform the interaction before stopping.';
  }
  const lines = [headline(analysis)];
  const findings = analysis.findings.slice(0, limit);
  if (findings.length === 0) {
    lines.push('No render problems above thresholds.');
  } else {
    findings.forEach((finding, index) => {
      lines.push(
        `${index + 1}. ${finding.kind} ${finding.component}: ${finding.evidence} -> ${finding.fix}`,
      );
    });
    const hidden = analysis.findings.length - findings.length;
    if (hidden > 0) lines.push(`+${hidden} smaller findings (--limit ${analysis.findings.length})`);
  }
  for (const note of analysis.notes) lines.push(`Note: ${note}`);
  if (analysis.naming === 'lookup') {
    lines.push(
      'Note: component names came from mounted elements; components unmounted during the profile are left out.',
    );
  }
  lines.push(
    'More: profile slow | profile rerenders | profile report <Component> | profile timeline | profile commit <N>',
  );
  return lines.join('\n');
}

function causeSummary(causes: RenderCauses): string {
  return (
    (Object.entries(causes) as [keyof RenderCauses, number][])
      .filter(([, count]) => count > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([cause, count]) => `${cause} ${count}`)
      .join(', ') || 'unrecorded'
  );
}

function omittedRows(shown: number, total: number): string[] {
  return shown < total ? [`  +${total - shown} more (--limit ${total})`] : [];
}

function keyCounts(record: Record<string, number>, limit = 4): string {
  return Object.entries(record)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([key, count]) => `${key} ${count}`)
    .join(', ');
}

function componentLine(component: ComponentProfile): string {
  const avg = component.renders > 0 ? component.selfMs / component.renders : 0;
  const instances = component.instances > 1 ? ` ${component.instances} inst` : '';
  return `${component.name} [${component.kind}] self ${ms(component.selfMs)} avg ${ms(avg)} max ${ms(component.maxSelfMs)} renders ${component.renders}${instances}`;
}

export function formatSlowComponents(analysis: ReactProfileAnalysis, limit: number): string {
  if (analysis.components.length === 0) return 'No component renders recorded.';
  const shown = analysis.components.slice(0, limit);
  return [
    'Components by self time:',
    ...shown.map((c) => `  ${componentLine(c)}`),
    ...omittedRows(shown.length, analysis.components.length),
  ].join('\n');
}

export function componentsByRenders(analysis: ReactProfileAnalysis): ComponentProfile[] {
  return [...analysis.components].sort((a, b) => b.renders - a.renders);
}

export function formatRerenders(analysis: ReactProfileAnalysis, limit: number): string {
  if (analysis.components.length === 0) return 'No component renders recorded.';
  const sorted = componentsByRenders(analysis).slice(0, limit);
  return [
    'Components by render count:',
    ...sorted.map((c) => {
      const props = keyCounts(c.changedProps);
      return `  ${c.name} [${c.kind}] ${c.renders} renders${c.instances > 1 ? ` ${c.instances} inst` : ''}: ${causeSummary(c.causes)}${props ? `; changed props ${props}` : ''}`;
    }),
    ...omittedRows(sorted.length, analysis.components.length),
  ].join('\n');
}

/** Every component of that name, such as `Row [memo]` and `Row [function]`; case-insensitive when no exact match. */
export function findComponents(analysis: ReactProfileAnalysis, name: string): ComponentProfile[] {
  const exact = analysis.components.filter((c) => c.name === name);
  if (exact.length > 0) return exact;
  return analysis.components.filter((c) => c.name.toLowerCase() === name.toLowerCase());
}

function componentDetail(analysis: ReactProfileAnalysis, component: ComponentProfile): string[] {
  const lines = [componentLine(component), `causes: ${causeSummary(component.causes)}`];
  const props = Object.entries(component.changedProps)
    .sort((a, b) => b[1] - a[1])
    .map(
      ([key, count]) =>
        `${key} ${count}${component.propKinds[key] ? ` (${component.propKinds[key]})` : ''}`,
    );
  if (props.length > 0) lines.push(`changed props: ${props.join(', ')}`);
  const state = keyCounts(component.changedState, 8);
  if (state) lines.push(`changed state: ${state}`);
  const hooks = keyCounts(component.changedHooks, 8);
  if (hooks) lines.push(`changed hooks (by index): ${hooks}`);
  const owners = keyCounts(component.owners, 3);
  if (owners) lines.push(`rendered by: ${owners}`);
  if (component.costliestCommits.length > 0) {
    const commits = component.costliestCommits.map(({ index, selfMs }) => {
      const commit = analysis.commits[index];
      return `#${index} ${ms(selfMs)}${commit ? ` of ${ms(commit.durationMs)}` : ''}`;
    });
    lines.push(`its costliest commits (self time of commit duration): ${commits.join(', ')}`);
  }
  return lines;
}

/** Reports each component of one name, then the findings that name it. */
export function formatComponentReport(
  analysis: ReactProfileAnalysis,
  components: ComponentProfile[],
): string {
  const lines = components.flatMap((component) => componentDetail(analysis, component));
  const name = components[0]?.name;
  for (const finding of analysis.findings.filter((f) => f.component === name))
    lines.push(`finding ${finding.kind}: ${finding.evidence} -> ${finding.fix}`);
  return lines.join('\n');
}

function commitLine(commit: CommitProfile): string {
  const trigger = commit.updaters.length > 0 ? ` <- ${commit.updaters.join(', ')}` : '';
  const mounts = commit.mounts > 0 ? ` (${commit.mounts} mounted)` : '';
  return `#${commit.index} +${seconds(commit.atMs)} ${ms(commit.durationMs)} ${commit.rendered} rendered${mounts}${trigger}`;
}

export function timelineCommits(
  analysis: ReactProfileAnalysis,
  byDuration: boolean,
): CommitProfile[] {
  return byDuration
    ? [...analysis.commits].sort((a, b) => b.durationMs - a.durationMs)
    : analysis.commits;
}

export function formatTimeline(
  analysis: ReactProfileAnalysis,
  limit: number,
  byDuration: boolean,
): string {
  if (analysis.commits.length === 0) return 'No commits recorded.';
  const commits = timelineCommits(analysis, byDuration);
  const shown = commits.slice(0, limit);
  const header = byDuration ? 'Slowest commits' : 'Commits';
  const range = shown.length < commits.length ? ` (${shown.length} of ${commits.length})` : '';
  return [`${header}${range}:`, ...shown.map((commit) => `  ${commitLine(commit)}`)].join('\n');
}

export function formatCommit(commit: CommitProfile, limit: number): string {
  const lines = [commitLine(commit)];
  const shown = commit.top.slice(0, limit);
  for (const entry of shown) {
    const instances = entry.instances > 1 ? ` x${entry.instances}` : '';
    lines.push(
      `  ${entry.name}${instances} self ${ms(entry.selfMs)} ${entry.causes.join('+') || 'unrecorded'}`,
    );
  }
  const hidden = commit.rendered - shown.reduce((sum, entry) => sum + entry.instances, 0);
  if (hidden > 0) lines.push(`  +${hidden} more component renders`);
  return lines.join('\n');
}
