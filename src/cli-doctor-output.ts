export { formatDoctorCheckDetailLines, formatDoctorCheckSummaryLine } from './doctor-output.ts';

let renderedDoctorProgress = false;

export function markDoctorProgressRendered(): void {
  renderedDoctorProgress = true;
}

export function consumeDoctorProgressRendered(): boolean {
  const rendered = renderedDoctorProgress;
  renderedDoctorProgress = false;
  return rendered;
}
