import { formatCliStatusMarker, type CliStatusMarkerStatus } from './cli-status-markers.ts';

let renderedDoctorProgress = false;

export function markDoctorProgressRendered(): void {
  renderedDoctorProgress = true;
}

export function consumeDoctorProgressRendered(): boolean {
  const rendered = renderedDoctorProgress;
  renderedDoctorProgress = false;
  return rendered;
}

export function formatDoctorCheckSummaryLine(check: Record<string, unknown>): string {
  const statusMarker = formatCliStatusMarker(doctorStatusMarker(check.status));
  return `${statusMarker} ${formatDoctorCheckLabel(check)}`;
}

export function formatDoctorCheckDetailLines(check: Record<string, unknown>): string[] {
  if (check.status !== 'fail' && check.status !== 'warn') return [];
  if (typeof check.command === 'string') return [`  run: ${check.command}`];
  if (typeof check.hint === 'string') return [`  hint: ${check.hint}`];
  return [];
}

function doctorStatusMarker(status: unknown): CliStatusMarkerStatus {
  if (status === 'pass') return 'pass';
  if (status === 'fail') return 'fail';
  if (status === 'warn') return 'warn';
  return 'skip';
}

function formatDoctorCheckLabel(check: Record<string, unknown>): string {
  const id = typeof check.id === 'string' && check.id.length > 0 ? check.id : 'check';
  const summary =
    typeof check.summary === 'string' && check.summary.length > 0 ? check.summary : id;
  return summary === id ? id : `${id}: ${summary}`;
}
