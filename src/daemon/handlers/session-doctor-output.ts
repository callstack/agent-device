import { emitRequestProgress } from '../request-progress.ts';
import type { DoctorCheck, DoctorStatus } from './session-doctor-types.ts';

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
    message: formatDoctorProgressMessage(check),
  });
}

function formatDoctorProgressMessage(check: DoctorCheck): string {
  return [formatDoctorProgressSummary(check), ...formatDoctorProgressDetails(check)].join('\n');
}

function formatDoctorProgressSummary(check: DoctorCheck): string {
  return `${doctorProgressMarker(check.status)} ${check.id}: ${check.summary}`;
}

function formatDoctorProgressDetails(check: DoctorCheck): string[] {
  if (check.status !== 'fail' && check.status !== 'warn') return [];
  if (check.command) return [`  run: ${check.command}`];
  if (check.hint) return [`  hint: ${check.hint}`];
  return [];
}

function doctorProgressMarker(status: DoctorStatus): string {
  if (status === 'pass') return '✓';
  if (status === 'fail') return '⨯';
  if (status === 'warn') return '!';
  return '-';
}
