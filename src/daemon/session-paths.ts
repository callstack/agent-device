import { resolveUserPath } from '@agent-device/host-kit/file';

export function safeSessionName(name: string): string {
  return name.replaceAll(/[^a-zA-Z0-9._-]/g, '_');
}

/**
 * Whether `name` addresses exactly one filesystem entry under a session dir.
 * `safeSessionName` already strips separators, so what is left to reject is the
 * empty name and the two relative-directory names — the shapes that would make
 * `path.join` leave the directory it was given. `SessionStore.resolveSessionDir`
 * refuses such a name (so no request can steer session artifacts outside the
 * sessions tree), and callers that accept a session or request id from the
 * network refuse it before addressing a record.
 */
export function isSafeSessionSegment(name: string): boolean {
  const safe = safeSessionName(name);
  return safe.length > 0 && safe !== '.' && safe !== '..';
}

export function expandSessionPath(filePath: string, cwd?: string): string {
  return resolveUserPath(filePath, { cwd });
}
