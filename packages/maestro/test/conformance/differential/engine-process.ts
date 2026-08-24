import { spawnSync } from 'node:child_process';
import type { ReplaySuiteResult } from '@agent-device/contracts/replay';

export type EngineResult = {
  engine: 'maestro' | 'agent-device';
  outcome: 'pass' | 'fail';
  exitCode: number;
  /** Failure provenance stays distinct from the behavioral comparison. */
  failureKind?: 'behavioral' | 'infrastructure';
};

export function runEngine(
  engine: EngineResult['engine'],
  command: string,
  args: string[],
): EngineResult {
  const [bin = '', ...rest] = command.split(' ').filter(Boolean);
  const result = spawnSync(bin, [...rest, ...args], { stdio: 'inherit', cwd: process.cwd() });
  const exitCode = result.status ?? 1;
  const infrastructureFailed = result.status === null || result.error !== undefined;
  return {
    engine,
    outcome: exitCode === 0 ? 'pass' : 'fail',
    exitCode,
    ...(exitCode === 0
      ? {}
      : {
          failureKind: infrastructureFailed ? ('infrastructure' as const) : ('behavioral' as const),
        }),
  };
}

export function classifyAgentDeviceFailure(stdout: string): 'behavioral' | 'infrastructure' {
  try {
    const envelope = JSON.parse(stdout) as { data?: ReplaySuiteResult };
    const failures = envelope.data?.failures;
    if (!Array.isArray(failures) || failures.length === 0) return 'infrastructure';
    return failures.some((failure) => failure.infrastructure === true)
      ? 'infrastructure'
      : 'behavioral';
  } catch {
    // A non-zero process that did not return the promised suite envelope never reached a
    // classifiable behavioral oracle. Keep it red, but do not call it a divergence.
    return 'infrastructure';
  }
}

export function runAgentDeviceEngine(command: string, args: string[]): EngineResult {
  const [bin = '', ...rest] = command.split(' ').filter(Boolean);
  const result = spawnSync(bin, [...rest, ...args, '--json'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  const exitCode = result.status ?? 1;
  const infrastructureFailed = result.status === null || result.error !== undefined;
  return {
    engine: 'agent-device',
    outcome: exitCode === 0 ? 'pass' : 'fail',
    exitCode,
    ...(exitCode === 0
      ? {}
      : {
          failureKind: infrastructureFailed
            ? ('infrastructure' as const)
            : classifyAgentDeviceFailure(result.stdout),
        }),
  };
}
