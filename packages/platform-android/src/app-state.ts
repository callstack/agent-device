import type { AppStateRuntimeResult } from '@agent-device/contracts/app-state-runtime';
import { deviceShellArgv, type ShellWord } from '@agent-device/kernel/device-shell';
import { parseAndroidFocusSegment } from './app-parsers.ts';

const FOCUS_COMMANDS = [
  ['dumpsys', 'window', 'windows'],
  ['dumpsys', 'window'],
] as const;
const ACTIVITY_COMMANDS = [
  ['dumpsys', 'activity', 'activities'],
  ['dumpsys', 'activity'],
] as const;
export type AndroidCommandExecutor = (
  args: readonly string[],
  options: { allowFailure: boolean },
) => Promise<{ exitCode: number; stdout?: string; stderr?: string }>;

export async function readAndroidAppStateWithExecutor(
  run: AndroidCommandExecutor,
  signal?: AbortSignal,
): Promise<AppStateRuntimeResult> {
  const windowFocus = await readAndroidFocusWithExecutor(run, FOCUS_COMMANDS, signal);
  if (windowFocus) return windowFocus;

  const activityFocus = await readAndroidFocusWithExecutor(run, ACTIVITY_COMMANDS, signal);
  if (activityFocus) return activityFocus;
  return {};
}

async function readAndroidFocusWithExecutor(
  run: AndroidCommandExecutor,
  commands: readonly (readonly ShellWord[])[],
  signal?: AbortSignal,
): Promise<AppStateRuntimeResult | null> {
  for (const words of commands) {
    signal?.throwIfAborted();
    const result = await run(deviceShellArgv('adb', 'shell', words), { allowFailure: true });
    signal?.throwIfAborted();
    const parsed = parseAndroidForegroundApp(result.stdout ?? '');
    if (parsed) return parsed;
  }
  return null;
}

export function parseAndroidForegroundApp(text: string): AppStateRuntimeResult | null {
  return parseAndroidFocusSegment(text, (segment) => parseAndroidComponentFromSegment(segment));
}

function parseAndroidComponentFromSegment(segment: string): AppStateRuntimeResult | null {
  const match = segment.match(/\b([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+)\/([A-Za-z0-9_.$]+)/);
  return match?.[1] && match[2] ? { package: match[1], activity: match[2] } : null;
}
