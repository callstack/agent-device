import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { deepButtonFixtureEvidence } from './deep-button.ts';

export class BenchmarkControlError extends Error {
  readonly command?: string;

  constructor(message: string, command?: string) {
    super(message);
    this.command = command;
  }
}

export function runDeepButtonControls(repoRoot: string) {
  const evidence = deepButtonFixtureEvidence();
  const script = path.join(repoRoot, 'scripts', 'ios-snapshot-benchmark', 'deep-button.ts');
  const invalid = runControl(repoRoot, script, 'invalid-shallow');
  assertInvalidControl(invalid, evidence.invalidShallowRule.assertion);
  const safe = runControl(repoRoot, script, 'safe-full');
  assertSafeControl(safe);
  return {
    ...evidence,
    invalidShallowRule: { ...evidence.invalidShallowRule, exitCode: invalid.status ?? -1 },
    safeFullRule: { ...evidence.safeFullRule, exitCode: safe.status ?? -1 },
  };
}

function runControl(
  repoRoot: string,
  script: string,
  rule: 'invalid-shallow' | 'safe-full',
): { status: number | null; stderr: string } {
  const result = spawnSync(
    process.execPath,
    ['--experimental-strip-types', script, '--rule', rule],
    { cwd: repoRoot, encoding: 'utf8', timeout: 30_000 },
  );
  return { status: result.status, stderr: result.stderr ?? '' };
}

function assertInvalidControl(
  result: { status: number | null; stderr: string },
  assertion: string,
): void {
  if (result.status === 1 && result.stderr.trim() === assertion) return;
  throw new BenchmarkControlError(
    `Invalid-shallow control did not produce the required red assertion (exit ${String(result.status)}).`,
    'pnpm bench:ios-snapshot:deep-button -- --rule invalid-shallow',
  );
}

function assertSafeControl(result: { status: number | null; stderr: string }): void {
  if (result.status === 0) return;
  throw new BenchmarkControlError(
    `Safe-full control failed: ${result.stderr.trim() || `exit ${String(result.status)}`}`,
    'pnpm bench:ios-snapshot:deep-button -- --rule safe-full',
  );
}
