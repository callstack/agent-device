import type {
  AuditFinding,
  AuditNameDetail,
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
  const guidance = Object.entries(result.guidance);
  if (guidance.length > 0)
    lines.push('', ...guidance.map(([kind, sentence]) => `${kind}: ${sentence}`));
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
      `${refs[index]!.padEnd(refWidth)}  ${finding.kind.padEnd(kindWidth)}  ${elementText(finding)}  ${findingText(finding)}`,
  );
}

function findingText(finding: AuditFinding): string {
  switch (finding.kind) {
    case 'small-target':
      return sizeText(finding.detail);
    case 'missing-name':
      return 'No accessible name';
    case 'ambiguous-name':
      return sharedNameText(finding.detail);
    case 'covered-control':
      return 'Accessible action is unavailable to touch';
  }
}

function sharedNameText({ count }: AuditNameDetail): string {
  return `Name shared by ${count} controls of this role`;
}

function sizeText({ width, height, unit, recommendedSize }: AuditSizeDetail): string {
  return `${width}×${height}${unit}, below ${recommendedSize}×${recommendedSize}${unit}`;
}

function elementText(finding: AuditFinding): string {
  // A control named by its content description, text or a child has no label of its own; the
  // shared name is still what a reader needs to find it.
  const name =
    finding.kind === 'missing-name'
      ? undefined
      : (finding.label ?? (finding.kind === 'ambiguous-name' ? finding.detail.name : undefined));
  const identity = name
    ? JSON.stringify(name)
    : finding.identifier
      ? `id=${JSON.stringify(finding.identifier)}`
      : undefined;
  return identity ? `${finding.role} ${identity}` : finding.role;
}
