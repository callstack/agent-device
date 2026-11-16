import type {
  AuditFinding,
  AuditSizeDetail,
  AuditSnapshotCommandResult,
} from '@agent-device/contracts/capture';
import { pinnedRefText, type CliOutput } from '../output-common.ts';

export function auditCliOutput(result: AuditSnapshotCommandResult): CliOutput {
  return { data: result, text: formatAuditText(result) };
}

function formatAuditText(result: AuditSnapshotCommandResult): string {
  const lines = [
    'agent-device audit',
    summaryLine(result.findings),
    ...findingLines(result.findings, result.refsGeneration),
  ];
  if (result.limitations.length > 0) {
    lines.push('', ...result.limitations.map((limitation) => `Limitation: ${limitation}`));
  }
  return `${lines.join('\n')}\n`;
}

function summaryLine(findings: readonly AuditFinding[]): string {
  const warnings = findings.filter((finding) => finding.severity === 'warning').length;
  const observations = findings.length - warnings;
  const counts = [plural(warnings, 'warning'), plural(observations, 'observation')].filter(
    (count) => count !== undefined,
  );
  return `${counts.length > 0 ? counts.join(', ') : 'No findings'} — current screen`;
}

function plural(count: number, noun: string): string | undefined {
  if (count === 0) return undefined;
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function findingLines(
  findings: readonly AuditFinding[],
  refsGeneration: number | undefined,
): string[] {
  const refs = findings.map((finding) => pinnedRefText(finding.ref, refsGeneration) ?? finding.ref);
  const refWidth = Math.max(0, ...refs.map((ref) => ref.length));
  const kindWidth = Math.max(0, ...findings.map((finding) => finding.kind.length));
  return findings.map(
    (finding, index) =>
      `${refs[index]!.padEnd(refWidth)}  ${finding.kind.padEnd(kindWidth)}  ${findingText(finding)}`,
  );
}

function findingText(finding: AuditFinding): string {
  switch (finding.kind) {
    case 'small-target':
      return `${sizeText(finding.detail)}; review touch area`;
    case 'missing-name':
      return `${capitalize(finding.role.replaceAll('-', ' '))} has no accessible name`;
    case 'covered-control':
      return 'Accessible action is unavailable to touch';
  }
}

function sizeText({ width, height, unit }: AuditSizeDetail): string {
  return `${width}×${height}${unit}`;
}

function capitalize(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}
