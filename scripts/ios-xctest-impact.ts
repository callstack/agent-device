import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const RUNNER_INPUTS = [
  'apple/runner/',
  'apple/snapshot-presentation/',
  'contracts/fixtures/',
  'packages/platform-apple/src/runner/',
  '.github/actions/setup-apple-runner-build/',
  '.github/workflows/ios.yml',
  'package.json',
  'pnpm-lock.yaml',
  'scripts/build-xcuitest-apple.sh',
  'scripts/patch-xcuitest-runner-icon.ts',
  'scripts/swift-toolchain-tmpdir.ts',
  'scripts/write-xcuitest-cache-metadata.mjs',
  'scripts/check-xctest-selection.ts',
  'scripts/xctest-declarations.ts',
  'scripts/swift-conditional-compilation.ts',
  'scripts/ios-xctest-impact.ts',
] as const;

export function affectsIosXctests(file: string): boolean {
  return RUNNER_INPUTS.some((input) =>
    input.endsWith('/') ? file.startsWith(input) : file === input,
  );
}

export function selectIosXctests(
  eventName: string,
  changedPaths: readonly string[] | null,
): { run: boolean; reason: string } {
  if (eventName !== 'pull_request')
    return { run: true, reason: 'main and manual runs exercise XCTest' };
  if (changedPaths === null || changedPaths.length === 0) {
    return { run: true, reason: 'the PR change set could not be established' };
  }
  const input = changedPaths.find(affectsIosXctests);
  return input
    ? { run: true, reason: `XCTest input changed: ${input}` }
    : { run: false, reason: 'the PR changed no XCTest runner, test, or golden-table input' };
}

export function uncoveredRunnerCacheInputs(action: string): string[] {
  const hashFiles = action.match(/hashFiles\(([^\n]+)\)/)?.[1];
  if (!hashFiles) return ['runner cache hashFiles declaration'];
  return [...hashFiles.matchAll(/'([^']+)'/g)]
    .map((match) => match[1] as string)
    .filter((input) => !affectsIosXctests(input.replace(/\*\*?$/, 'probe.swift')));
}

function changedPathsFromGit(baseSha: string): string[] | null {
  if (!/^[a-f0-9]{40}$/.test(baseSha)) return null;
  const result = spawnSync('git', ['diff', '--name-only', '-z', baseSha, 'HEAD'], {
    encoding: 'utf8',
  });
  if (result.error || result.status !== 0 || result.stdout === null) return null;
  return result.stdout.split('\0').filter(Boolean);
}

if (process.argv[1]?.endsWith('/ios-xctest-impact.ts')) {
  const eventName = process.env.GITHUB_EVENT_NAME ?? '';
  const changedPaths =
    eventName === 'pull_request' ? changedPathsFromGit(process.env.BASE_SHA ?? '') : [];
  const selection = selectIosXctests(eventName, changedPaths);
  process.stdout.write(`iOS XCTest: ${selection.run ? 'run' : 'skip'}; ${selection.reason}\n`);
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `run=${selection.run}\n`);
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `### iOS XCTest selection\n\n${selection.run ? 'Run' : 'Skip'}: ${selection.reason}.\n`,
    );
  }
}
