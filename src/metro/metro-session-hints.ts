import fs from 'node:fs';
import path from 'node:path';
import { safeSessionName } from '../daemon/session-paths.ts';

/**
 * Local dev-server coordinates persisted by `metro prepare` for a CLI session so a later
 * `metro reload` in the same session targets the dev server `prepare` actually bound, instead
 * of silently falling back to the Metro default host/port and reloading an unrelated project.
 */
export type MetroSessionHints = {
  metroHost?: string;
  metroPort?: number;
};

function metroSessionHintsPath(stateDir: string, session: string): string {
  return path.join(stateDir, 'metro-sessions', `${safeSessionName(session)}.json`);
}

export function writeMetroSessionHints(options: {
  stateDir: string;
  session: string;
  hints: MetroSessionHints;
}): void {
  const filePath = metroSessionHintsPath(options.stateDir, options.session);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(options.hints, null, 2)}\n`, 'utf8');
}

export function readMetroSessionHints(options: {
  stateDir: string;
  session: string;
}): MetroSessionHints | undefined {
  const filePath = metroSessionHintsPath(options.stateDir, options.session);
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  const hints: MetroSessionHints = {};
  if (typeof record.metroHost === 'string' && record.metroHost) hints.metroHost = record.metroHost;
  if (typeof record.metroPort === 'number' && Number.isInteger(record.metroPort)) {
    hints.metroPort = record.metroPort;
  }
  return Object.keys(hints).length > 0 ? hints : undefined;
}

export function clearMetroSessionHints(options: { stateDir: string; session: string }): void {
  fs.rmSync(metroSessionHintsPath(options.stateDir, options.session), { force: true });
}
