import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { runCmdSync } from '@agent-device/host-kit/command';
import type { DryRunCompletedEvent } from '@stryker-mutator/api/report';
import { DryRunStatus, TestStatus } from '@stryker-mutator/api/test-runner';
import { normalizePath, type ModuleId } from './modules.ts';

export type ScopeIdentity = { module: ModuleId; epoch: string; seed: number; fingerprint: string };
export type CoverageScope = {
  schemaVersion: 1;
  identity: ScopeIdentity;
  candidates: string[];
  covered: string[];
  initialRunMs: number;
  producerMs: number;
  checksum: string;
};

function scopeChecksum(scope: Omit<CoverageScope, 'checksum'>): string {
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify([
        scope.schemaVersion,
        [
          scope.identity.module,
          scope.identity.epoch,
          scope.identity.seed,
          scope.identity.fingerprint,
        ],
        scope.candidates,
        scope.covered,
        scope.initialRunMs,
        scope.producerMs,
      ]),
    )
    .digest('hex');
}

/** Conservative pilot identity: content/inventory, installed tools, Node and environment. */
export function scopeFingerprint(root: string): string {
  const hash = crypto.createHash('sha256');
  const files = runCmdSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    {
      cwd: root,
    },
  )
    .stdout.split('\0')
    .filter(Boolean)
    .sort();
  for (const file of files) {
    hash.update(
      JSON.stringify([
        file,
        fs.statSync(path.join(root, file)).mode,
        crypto
          .createHash('sha256')
          .update(fs.readFileSync(path.join(root, file)))
          .digest('hex'),
      ]),
    );
  }
  for (const name of [
    '@stryker-mutator/core',
    '@stryker-mutator/api',
    '@stryker-mutator/instrumenter',
    '@stryker-mutator/vitest-runner',
    'vitest',
    'fast-check',
  ]) {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(root, 'node_modules', name, 'package.json'), 'utf8'),
    );
    hash.update(JSON.stringify([name, pkg.version]));
  }
  const environment = Object.entries(process.env)
    .filter(([key]) => !['_', 'SHLVL', 'PWD', 'OLDPWD'].includes(key))
    .sort(([a], [b]) => a.localeCompare(b));
  hash.update(JSON.stringify([process.versions, process.platform, process.arch, environment]));
  return `sha256:${hash.digest('hex')}`;
}

/** The union Stryker's current per-test planner can actually schedule. */
export function coverageScope(
  event: DryRunCompletedEvent,
  identity: ScopeIdentity,
  candidates: readonly string[],
  root: string,
  producerMs: number,
): CoverageScope {
  const coverage = event.result.mutantCoverage?.perTest;
  if (event.result.status !== DryRunStatus.Complete || !coverage)
    throw new Error('Scope probe must provide successful per-test mutation coverage');
  const tests = new Map(event.result.tests.map((test) => [test.id, test]));
  if (event.result.tests.some((test) => test.status === TestStatus.Failed))
    throw new Error('Scope probe contains failed tests');
  const allowed = new Set(candidates);
  const covered = new Set<string>();
  for (const [id, hits] of Object.entries(coverage)) {
    if (!Object.values(hits).some((count) => count > 0)) continue;
    const test = tests.get(id);
    if (!test?.fileName) throw new Error(`Scope probe cannot attribute covering test ${id}`);
    const file = normalizePath(path.relative(root, test.fileName));
    if (!allowed.has(file))
      throw new Error(`Scope probe returned an unexpected test file: ${file}`);
    covered.add(file);
  }
  if (covered.size === 0) throw new Error('Scope probe has no attributed covering test files');
  const scope: Omit<CoverageScope, 'checksum'> = {
    schemaVersion: 1,
    identity,
    candidates: [...candidates].sort(),
    covered: [...covered].sort(),
    initialRunMs: event.timing.net + event.timing.overhead,
    producerMs,
  };
  return { ...scope, checksum: scopeChecksum(scope) };
}

export function scopedTestFiles(
  index: CoverageScope,
  expected: ScopeIdentity,
  candidates: readonly string[],
): string[] {
  if (
    index?.schemaVersion !== 1 ||
    !index.identity ||
    (Object.keys(expected) as (keyof ScopeIdentity)[]).some(
      (key) => index.identity[key] !== expected[key],
    )
  )
    throw new Error('Coverage scope does not match this module, epoch, seed or execution inputs');
  if (
    !Array.isArray(index.candidates) ||
    index.candidates.some((file) => typeof file !== 'string') ||
    !Array.isArray(index.covered) ||
    !index.covered.length ||
    index.covered.some((file) => typeof file !== 'string' || !index.candidates.includes(file))
  )
    throw new Error('Coverage scope contains invalid test files');
  if (
    index.checksum !== scopeChecksum(index) ||
    !Number.isFinite(index.producerMs) ||
    !Number.isFinite(index.initialRunMs)
  )
    throw new Error('Coverage scope checksum or timing is invalid');
  if (candidates.some((file) => !index.candidates.includes(file)))
    throw new Error('Coverage scope omits a current candidate test file');
  const allowed = new Set(candidates);
  const selected = [...new Set(index.covered.filter((file) => allowed.has(file)))].sort();
  if (!selected.length) throw new Error('Coverage scope selected no tests for this shard');
  return selected;
}

export function assertCoveragePolicy(config: {
  coverageAnalysis?: string;
  ignoreStatic?: boolean;
  incremental?: boolean;
}): void {
  if (config.coverageAnalysis !== 'perTest' || config.ignoreStatic !== true || config.incremental)
    throw new Error('Coverage scope requires fresh perTest coverage with ignoreStatic enabled');
}
