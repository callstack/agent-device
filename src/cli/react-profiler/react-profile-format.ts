import type { ReactProfileAnalysis } from './react-profile-analysis.ts';
import { FRAME_BUDGET_MS, formatMs } from './react-profile-renders.ts';

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
      'Note: component names came from mounted elements; components unmounted during the profile may show as Unknown.',
    );
  }
  return lines.join('\n');
}
