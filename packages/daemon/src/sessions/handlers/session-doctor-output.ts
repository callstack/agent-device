import { emitRequestProgress } from '@agent-device/host-kit/request';
import {
  doctorCheckStatusMarker,
  formatDoctorCheckDetailLines,
  formatDoctorCheckSummaryLine,
} from '@agent-device/host-kit/doctor-lines';
import type { DoctorCheck, DoctorStatus } from '@agent-device/contracts/observability';

export function summarizeDoctorStatus(checks: DoctorCheck[]): 'pass' | 'warn' | 'fail' {
  if (checks.some((check) => check.status === 'fail')) return 'fail';
  if (checks.some((check) => check.status === 'warn')) return 'warn';
  return 'pass';
}

export function doctorSummary(status: 'pass' | 'warn' | 'fail'): string {
  if (status === 'fail') return 'Blockers found before the run.';
  if (status === 'warn') return 'No hard blockers found, but warnings need attention.';
  return 'No blockers found.';
}

export function sortChecks(checks: DoctorCheck[]): DoctorCheck[] {
  const order: Record<DoctorStatus, number> = { fail: 0, warn: 1, pass: 2, info: 3 };
  return [...checks].sort((a, b) => order[a.status] - order[b.status]);
}

export function appendDoctorChecks(checks: DoctorCheck[], ...items: DoctorCheck[]): void {
  for (const check of items) {
    appendDoctorCheck(checks, check);
  }
}

export function appendDoctorCheck(checks: DoctorCheck[], check: DoctorCheck): void {
  checks.push(check);
  emitRequestProgress({
    type: 'command',
    status: 'progress',
    message: formatDoctorCheckProgressMessage(check),
    marker: doctorCheckStatusMarker(check.status),
  });
}

/**
 * The line streamed for one check, uncolored: the marker's status travels as `marker`, and the CLI colors it after
 * escaping the text, so no color code crosses the wire.
 */
function formatDoctorCheckProgressMessage(check: DoctorCheck): string {
  return [
    formatDoctorCheckSummaryLine(check, { useColor: false }),
    ...formatDoctorCheckDetailLines(check),
  ].join('\n');
}
