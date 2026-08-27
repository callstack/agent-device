import { AppError } from '@agent-device/kernel/errors';

export type AppearanceAction = 'light' | 'dark' | 'toggle';

// fallow-ignore-next-line code-duplication
export function parseAppearanceAction(state: string): AppearanceAction {
  const normalized = state.trim().toLowerCase();
  if (normalized === 'light') return 'light';
  if (normalized === 'dark') return 'dark';
  if (normalized === 'toggle') return 'toggle';
  throw new AppError('INVALID_ARGS', `Invalid appearance state: ${state}. Use light|dark|toggle.`);
}

// fallow-ignore-next-line code-duplication
export function parseSettingState(state: string): boolean {
  const normalized = state.toLowerCase();
  if (normalized === 'on' || normalized === 'true' || normalized === '1') return true;
  if (normalized === 'off' || normalized === 'false' || normalized === '0') return false;
  throw new AppError('INVALID_ARGS', `Invalid setting state: ${state}`);
}

// fallow-ignore-next-line code-duplication
export type CommandAttemptFailure = {
  args: string[];
  stdout: string;
  stderr: string;
  exitCode: number;
};

// fallow-ignore-next-line code-duplication
export function summarizeCommandAttemptFailures(
  failures: CommandAttemptFailure[],
): Array<{ args: string; exitCode: number; stderr: string }> {
  return failures.map((failure) => ({
    args: failure.args.join(' '),
    exitCode: failure.exitCode,
    stderr: failure.stderr.slice(0, 400),
  }));
}
