import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '@agent-device/kernel/errors';
import type { EnvMap } from '@agent-device/kernel/source-value';

const BARE_COMMAND_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
const WINDOWS_PATH_EXTENSIONS = ['.com', '.exe', '.bat', '.cmd'];

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

export async function resolveExecutableOverridePath(
  rawPath: string | undefined,
  envName: string,
): Promise<string | undefined> {
  return await resolveOverridePath(rawPath, envName, 'executable', isExecutablePath);
}

export async function resolveFileOverridePath(
  rawPath: string | undefined,
  envName: string,
): Promise<string | undefined> {
  return await resolveOverridePath(rawPath, envName, 'file', isFilePath);
}

async function resolveOverridePath(
  rawPath: string | undefined,
  envName: string,
  kind: 'executable' | 'file',
  isUsable: (candidate: string) => Promise<boolean>,
): Promise<string | undefined> {
  const candidate = normalizeOverridePath(rawPath, envName, kind);
  if (!candidate) return undefined;
  if (!(await isUsable(candidate))) {
    throw new AppError(
      'TOOL_MISSING',
      `${envName} points to a missing or non-${kind} ${kind === 'file' ? 'path' : 'file'}: ${candidate}`,
      { envName, path: candidate },
    );
  }
  return candidate;
}

export function normalizeExecutableCommand(cmd: string): string {
  const candidate = normalizeExecutableLookup(cmd);
  if (!candidate) {
    throw new AppError('INVALID_ARGS', `Invalid executable command: ${JSON.stringify(cmd)}`, {
      cmd,
      hint: 'Use a bare command name from PATH or an absolute executable path.',
    });
  }
  return candidate;
}

function normalizeOverridePath(
  rawPath: string | undefined,
  envName: string,
  kind: 'executable' | 'file',
): string | undefined {
  const candidate = rawPath?.trim();
  if (!candidate) return undefined;
  if (!path.isAbsolute(candidate) || candidate.includes('\0')) {
    throw new AppError(
      'INVALID_ARGS',
      `${envName} must be an absolute ${kind} path, not ${JSON.stringify(rawPath)}`,
      { envName, path: rawPath },
    );
  }
  return candidate;
}

function normalizeExecutableLookup(cmd: string): string | null {
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

export async function isExecutablePath(filePath: string): Promise<boolean> {
  try {
    if (!(await isFilePath(filePath))) return false;
    await access(filePath, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function isFilePath(filePath: string): Promise<boolean> {
  try {
    const fileStat = await stat(filePath);
    return fileStat.isFile();
  } catch {
    return false;
  }
}
