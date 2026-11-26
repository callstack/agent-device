import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { shellQuote } from '@agent-device/kernel/device-shell';
import type { FakeAdbResponse } from './fake-adb.ts';
import { mkdtempForTestSync } from './tmp-dir.ts';

export type FakePmReply = Readonly<{
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}>;

/**
 * Executes a batched Android `pm` shell script in real `/bin/sh` with a shell-function `pm()`
 * shim that records every executed `pm` argv losslessly and returns per-command replies.
 */
export function runFakeAndroidPmBatchInSh(
  script: string,
  pmReplies: Readonly<Record<string, FakePmReply>>,
  recordedPmCalls: string[][],
): FakeAdbResponse {
  const dir = mkdtempForTestSync('agent-device-fake-pm-');
  const logPath = path.join(dir, 'pm-calls.bin');
  try {
    const cases = Object.entries(pmReplies)
      .map(([flatPmArgs, reply]) => {
        const actions: string[] = [];
        if (reply.stdout) actions.push(`printf '%s' ${shellQuote(reply.stdout)}`);
        if (reply.stderr) actions.push(`printf '%s' ${shellQuote(reply.stderr)} >&2`);
        actions.push(`return ${reply.exitCode ?? 0}`);
        return `${shellQuote(flatPmArgs)}) ${actions.join('; ')} ;;`;
      })
      .join(' ');

    const pmShim = [
      `__FAKE_PM_LOG=${shellQuote(logPath)}`,
      'pm() {',
      String.raw`  for __a in "$@"; do printf '%s\0' "$__a" >> "$__FAKE_PM_LOG"; done`,
      String.raw`  printf '__PM_CALL_END__\0' >> "$__FAKE_PM_LOG"`,
      `  case "shell pm $*" in ${cases} *) return 0 ;; esac`,
      '}',
    ].join('\n');

    const result = spawnSync('/bin/sh', ['-c', `${pmShim}\n${script}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.error) throw result.error;

    if (fs.existsSync(logPath)) {
      const tokens = fs.readFileSync(logPath).toString('utf8').split('\0');
      let current: string[] = [];
      for (const token of tokens) {
        if (token === '__PM_CALL_END__') {
          recordedPmCalls.push(current);
          current = [];
        } else if (token.length > 0 || current.length > 0) {
          current.push(token);
        }
      }
    }

    return {
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      exitCode: result.status ?? 1,
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export function isAndroidPmBatchShellArgs(args: readonly string[]): boolean {
  return args[0] === 'shell' && args.length === 2 && args[1]!.includes('__AD_PM_BATCH_');
}

/**
 * A fake adb script for `settings permission ... all`: batched `pm` scripts run through
 * {@link runFakeAndroidPmBatchInSh}, single `shell pm ...` calls answer from the same
 * `pmReplies`, and both land in `pmCalls`. Everything else goes to `fallback`.
 */
export function createFakeAndroidPmAdb(
  fallback: (args: string[]) => FakeAdbResponse | undefined,
  pmReplies: Readonly<Record<string, FakePmReply>> = {},
) {
  const pmCalls: string[][] = [];
  const batchOptions: Array<{ timeoutMs?: number }> = [];
  const script = (args: string[], options?: { timeoutMs?: number }) => {
    if (isAndroidPmBatchShellArgs(args)) {
      batchOptions.push({ timeoutMs: options?.timeoutMs });
      return runFakeAndroidPmBatchInSh(args[1]!, pmReplies, pmCalls);
    }
    if (args[0] === 'shell' && args[1] === 'pm') {
      pmCalls.push(args.slice(2));
      const reply = pmReplies[args.join(' ')];
      if (reply) return { stdout: '', stderr: '', exitCode: 0, ...reply };
    }
    return fallback(args);
  };
  return {
    script,
    pmCalls,
    batchOptions,
    flatPmCalls: () => pmCalls.map((argv) => ['shell', 'pm', ...argv].join(' ')),
  };
}
