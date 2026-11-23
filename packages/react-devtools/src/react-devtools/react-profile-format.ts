import { isFindingFor, type ReactProfileAnalysis } from './react-profile-analysis.ts';
import {
  FRAME_BUDGET_MS,
  formatMs,
  type CommitProfile,
  type ComponentProfile,
  type RenderCauses,
} from './react-profile-renders.ts';
import { printableLines } from './react-devtools-text.ts';

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
  const notes = analysis.notes.map((note) => `Note: ${note}`);
  if (analysis.commitCount === 0) {
    return printableLines([
      'React profile: no commits recorded. Start profiling, then perform the interaction before stopping.',
      ...notes,
    ]);
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
  lines.push(...notes);
  if (analysis.naming === 'lookup') {
    lines.push(
      'Note: component names came from mounted elements; components unmounted during the profile are left out.',
    );
  }
  lines.push('More: profile report [Component] | profile commit [N]');
  return printableLines(lines);
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

/** One line per component, costliest first: its cost, then why it rendered. */
export function formatComponents(analysis: ReactProfileAnalysis, limit: number): string {
  if (analysis.components.length === 0) return 'No component renders recorded.';
  const shown = analysis.components.slice(0, limit);
  return printableLines([
    'Components by self time:',
    ...shown.map((c) => {
      const props = keyCounts(c.changedProps);
      return `  ${componentLine(c)}: ${causeSummary(c.causes)}${props ? `; changed props ${props}` : ''}`;
    }),
    ...omittedRows(shown.length, analysis.components.length),
  ]);
}

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

/** Reports each component of one name with the findings about it. */
export function formatComponentReport(
  analysis: ReactProfileAnalysis,
  components: ComponentProfile[],
): string {
  return printableLines(
    components.flatMap((component) => [
      ...componentDetail(analysis, component),
      ...analysis.findings
        .filter((finding) => isFindingFor(finding, component))
        .map((finding) => `finding ${finding.kind}: ${finding.evidence} -> ${finding.fix}`),
    ]),
  );
}

function commitLine(commit: CommitProfile): string {
  const trigger =
    commit.updaters.length > 0
      ? ` <- ${commit.updaters.map((updater) => updater.name).join(', ')}`
      : '';
  const mounts = commit.mounts > 0 ? ` (${commit.mounts} mounted)` : '';
  return `#${commit.index} +${seconds(commit.atMs)} ${ms(commit.durationMs)} ${commit.rendered} rendered${mounts}${trigger}`;
}

/** Every commit in order, or the slowest `limit` of them, still in order. */
export function listedCommits(analysis: ReactProfileAnalysis, limit: number): CommitProfile[] {
  if (analysis.commits.length <= limit) return analysis.commits;
  return [...analysis.commits]
    .sort((a, b) => b.durationMs - a.durationMs)
    .slice(0, limit)
    .sort((a, b) => a.index - b.index);
}

export function formatCommits(analysis: ReactProfileAnalysis, limit: number): string {
  if (analysis.commits.length === 0) return 'No commits recorded.';
  const shown = listedCommits(analysis, limit);
  const header =
    shown.length < analysis.commits.length
      ? `Commits (${shown.length} slowest of ${analysis.commits.length}, --limit ${analysis.commits.length} for all):`
      : 'Commits:';
  return printableLines([header, ...shown.map((commit) => `  ${commitLine(commit)}`)]);
}

export function formatCommit(commit: CommitProfile, limit: number): string {
  const lines = [commitLine(commit)];
  const shown = commit.components.slice(0, limit);
  for (const entry of shown) {
    const instances = entry.instances > 1 ? ` x${entry.instances}` : '';
    lines.push(
      `  ${entry.name} [${entry.kind}]${instances} self ${ms(entry.selfMs)} ${entry.causes.join('+') || 'unrecorded'}`,
    );
  }
  lines.push(...omittedRows(shown.length, commit.components.length));
  return printableLines(lines);
}
