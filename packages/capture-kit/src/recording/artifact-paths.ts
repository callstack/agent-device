import path from 'node:path';

/**
 * The path a recorder writes to when its own file must stay separate from the export (ADR 0024 2.3).
 * A recorder that is still writing owns its path; the export is produced from a copy of it, so a stop
 * that fails midway cannot leave the caller's path holding a half-written file the next attempt has
 * to reason about.
 */
export function nativeRecordingPath(exportPath: string): string {
  return siblingRecordingPath(exportPath, 'native');
}

/**
 * The immutable copy a stop takes from the recorder's path before it touches the export. Everything
 * after this checkpoint — overlay, telemetry, container repair — is reproducible from this file, so
 * a retry resumes here instead of asking the recorder again.
 */
export function collectedRecordingPath(exportPath: string): string {
  return siblingRecordingPath(exportPath, 'collected');
}

function siblingRecordingPath(exportPath: string, role: 'native' | 'collected'): string {
  const extension = path.extname(exportPath);
  const base = extension === '' ? exportPath : exportPath.slice(0, -extension.length);
  return `${base}.${role}${extension}`;
}
