import { splitNonEmptyTrimmedLines } from '@agent-device/kernel/record';
import { roundPercent } from '@agent-device/kernel/numeric';

const SIMPLEPERF_REPORT_ARTIFACT_ENTRY_LIMIT = 50;

export type SimpleperfReportEntry = {
  percentage: number;
  command?: string;
  dso?: string;
  symbol?: string;
};

export function parseSimpleperfReportEntries(stdout: string): SimpleperfReportEntry[] {
  const entries: SimpleperfReportEntry[] = [];
  for (const line of splitNonEmptyTrimmedLines(stdout)) {
    const match = line.match(/^([0-9]+(?:\.[0-9]+)?)%\s+(.+)$/);
    if (!match) continue;
    const percentage = Number(match[1]);
    const rest = match[2]?.trim();
    if (!Number.isFinite(percentage) || !rest) continue;
    const columns = rest.split(/\s{2,}/).filter(Boolean);
    entries.push({
      percentage: roundPercent(percentage),
      command: columns[0],
      dso: columns[1],
      symbol: columns.slice(2).join(' ') || undefined,
    });
    if (entries.length >= SIMPLEPERF_REPORT_ARTIFACT_ENTRY_LIMIT) break;
  }
  return entries;
}
