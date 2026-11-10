import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { AppError, asAppError } from '@agent-device/kernel/errors';

export type HostEnv = Readonly<Record<string, string | undefined>>;

const SDK_HINT =
  'Install the VS Code Tizen extension and run its Set Up step, set TIZEN_SDK to the SDK data directory, or set the plugin option sdbPath.';
const CONNECT_HINT =
  'Check that the TV is on, in Developer Mode with this host IP set, and reachable with sdb connect <ip>.';

// sdb ships only inside the VS Code Tizen extension's SDK, never on PATH. The extension records
// the SDK root in ~/.tizen.path.config.
function sdkDataDirs(env: HostEnv): string[] {
  const dirs = env.TIZEN_SDK ? [env.TIZEN_SDK] : [];
  const config = path.join(env.HOME ?? homedir(), '.tizen.path.config');
  if (existsSync(config)) {
    try {
      const { url } = JSON.parse(readFileSync(config, 'utf8')) as { url?: unknown };
      if (typeof url === 'string') dirs.push(path.join(url, 'server/sdktools/data'));
    } catch {
      // An unreadable config is the same as no config: the SDK is not found.
    }
  }
  return dirs;
}

export function locateSdb(explicit: string | undefined, env: HostEnv): string {
  if (explicit) return explicit;
  const found = sdkDataDirs(env)
    .map((dir) => path.join(dir, 'tools', process.platform === 'win32' ? 'sdb.exe' : 'sdb'))
    .find((candidate) => existsSync(candidate));
  if (!found) {
    throw new AppError('TOOL_MISSING', 'sdb was not found in a Tizen SDK', { hint: SDK_HINT });
  }
  return found;
}

export function sdbError(name: string, error: unknown): AppError {
  const failure = asAppError(error, 'COMMAND_FAILED');
  if (failure.code === 'TOOL_MISSING') {
    return new AppError('TOOL_MISSING', 'sdb is not installed at the configured path', {
      hint: SDK_HINT,
    });
  }
  if (failure.details?.processExitError !== true) return failure;
  const output = (key: string) => {
    const value = failure.details?.[key];
    return typeof value === 'string' ? value.trim() : '';
  };
  const detail = output('stderr') || output('stdout');
  return new AppError('COMMAND_FAILED', `${name} failed${detail ? `: ${detail}` : ''}`, {
    hint: CONNECT_HINT,
    processExitError: true,
  });
}
