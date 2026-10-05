import path from 'node:path';

const REMOTE_TEMP_DIR = '/tmp';

/** The daemon-host temp path a remote client names for an artifact it downloads afterwards. */
export function buildRemoteTempArtifactPath(prefix: string, extension: string): string {
  const safeExtension = extension.startsWith('.') ? extension : `.${extension}`;
  return path.posix.join(REMOTE_TEMP_DIR, `${remoteTempArtifactStem(prefix)}${safeExtension}`);
}

/** A directory temp path — unlike `buildRemoteTempArtifactPath`, no extension is ever appended. */
export function buildRemoteTempArtifactDirPath(prefix: string): string {
  return path.posix.join(REMOTE_TEMP_DIR, remoteTempArtifactStem(prefix));
}

/** Whether `value` has the shape `buildRemoteTempArtifactPath(prefix, extension)` returns. */
export function isRemoteTempArtifactPath(
  value: string,
  prefix: string,
  extension: string,
): boolean {
  const stem = path.posix.basename(value, extension);
  return (
    value === path.posix.join(REMOTE_TEMP_DIR, `${stem}${extension}`) &&
    stem.startsWith(`agent-device-${prefix}-`) &&
    /^\d+-[a-z0-9]+$/.test(stem.slice(`agent-device-${prefix}-`.length))
  );
}

function remoteTempArtifactStem(prefix: string): string {
  return `agent-device-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
