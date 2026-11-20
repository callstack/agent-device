import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import path from 'node:path';
import type { EnvMap } from '@agent-device/kernel/source-value';

const BARE_COMMAND_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
const WINDOWS_PATH_EXTENSIONS = ['.com', '.exe', '.bat', '.cmd'];

export function normalizeExecutableLookup(cmd: string): string | null {
  const candidate = cmd.trim();
  if (!candidate || candidate.includes('\0')) return null;
  if (path.isAbsolute(candidate)) return candidate;
  if (candidate.includes('/') || candidate.includes('\\')) {
    return null;
  }
  return BARE_COMMAND_RE.test(candidate) ? candidate : null;
}

/** Windows names an environment variable in any case; a captured copy no longer folds it. */
function readPathVariable(env: EnvMap, name: 'PATH' | 'PATHEXT'): string | undefined {
  if (process.platform !== 'win32') return env[name];
  const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name);
  return key === undefined ? undefined : env[key];
}

function resolvePathExtensions(env: EnvMap): string[] {
  if (process.platform !== 'win32') return [''];
  const rawPathExt = readPathVariable(env, 'PATHEXT');
  if (!rawPathExt) return WINDOWS_PATH_EXTENSIONS;
  const extensions = rawPathExt
    .split(';')
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length > 0);
  return extensions.length > 0 ? extensions : WINDOWS_PATH_EXTENSIONS;
}

function resolveExecutableCandidates(cmd: string, pathExtensions: string[]): string[] {
  if (process.platform !== 'win32') return [cmd];
  const lowered = cmd.toLowerCase();
  if (pathExtensions.some((extension) => lowered.endsWith(extension))) {
    return [cmd];
  }
  return pathExtensions.map((extension) => `${cmd}${extension}`);
}

export async function whichCmd(cmd: string, env: EnvMap): Promise<boolean> {
  const candidate = normalizeExecutableLookup(cmd);
  if (!candidate) return false;

  if (path.isAbsolute(candidate)) {
    return isExecutablePath(candidate);
  }

  const pathValue = readPathVariable(env, 'PATH');
  if (!pathValue) return false;
  const pathExtensions = resolvePathExtensions(env);
  for (const directory of pathValue.split(path.delimiter)) {
    const trimmedDirectory = directory.trim();
    if (!trimmedDirectory) continue;
    for (const entry of resolveExecutableCandidates(candidate, pathExtensions)) {
      if (await isExecutablePath(path.join(trimmedDirectory, entry))) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Every executable match of a bare command across PATH, in PATH order (`which -a` semantics).
 * An absolute `cmd` resolves nothing here: this answers "which installs are reachable", and a
 * spelled-out path is not a PATH answer.
 */
export async function findPathCommandInstances(cmd: string, env: EnvMap): Promise<string[]> {
  const candidate = normalizeExecutableLookup(cmd);
  if (!candidate || path.isAbsolute(candidate)) return [];
  const pathValue = readPathVariable(env, 'PATH');
  if (!pathValue) return [];
  const pathExtensions = resolvePathExtensions(env);
  const hits: string[] = [];
  const seen = new Set<string>();
  for (const directory of pathValue.split(path.delimiter)) {
    const trimmedDirectory = directory.trim();
    if (!trimmedDirectory) continue;
    for (const entry of resolveExecutableCandidates(candidate, pathExtensions)) {
      const hit = path.join(trimmedDirectory, entry);
      if (seen.has(hit)) continue;
      if (await isExecutablePath(hit)) {
        seen.add(hit);
        hits.push(hit);
      }
    }
  }
  return hits;
}

export async function isExecutablePath(filePath: string): Promise<boolean> {
  try {
    if (!(await isFilePath(filePath))) return false;
    await access(filePath, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function isFilePath(filePath: string): Promise<boolean> {
  try {
    const fileStat = await stat(filePath);
    return fileStat.isFile();
  } catch {
    return false;
  }
}
