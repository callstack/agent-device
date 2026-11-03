import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { REPO_ROOT } from '@agent-device/test-kit';

/**
 * The refusal-code table `contracts/fixtures/ios-snapshot-bridge-refusals.json` is the one list of
 * codes the snapshot bridge emits. The emitters are string literals in Objective-C, Swift, and
 * TypeScript, so only a source scan can notice a renamed code, which the policy would otherwise
 * move to generation scope without a sound.
 */

type Fixture = {
  captureScoped: { code: string; consequence: string }[];
  generationScoped: string[];
};

const fixture = JSON.parse(
  fs.readFileSync(
    path.join(REPO_ROOT, 'contracts/fixtures/ios-snapshot-bridge-refusals.json'),
    'utf8',
  ),
) as Fixture;

const fixtureCodes = [
  ...fixture.captureScoped.map(({ code }) => code),
  ...fixture.generationScoped,
];

function read(relative: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relative), 'utf8');
}

function filesIn(directory: string, extension: string): string[] {
  return fs
    .readdirSync(path.join(REPO_ROOT, directory))
    .filter((name) => name.endsWith(extension) && !name.endsWith('.test.ts'))
    .map((name) => `${directory}/${name}`);
}

const RUNNER_OBJC =
  'apple/runner/AgentDeviceRunner/AgentDeviceRunnerUITests/RunnerSnapshotBridge.m';
const RUNNER_SWIFT =
  'apple/runner/AgentDeviceRunner/AgentDeviceRunnerUITests/RunnerTests+SnapshotBridge.swift';

/**
 * Codes the scans below cannot see. `unknown` and `guest-error` are one-word defaults for a refusal
 * that names no code. Each must still appear as its literal, so a removed default fails here.
 */
const DEFAULT_CODE_LITERALS = [
  { code: 'unknown', file: 'apple/snapshot-bridge/SnapshotBridgeRequest.m', literal: '@"unknown"' },
  {
    code: 'guest-error',
    file: 'packages/platform-apple/src/snapshot-source/protocol.ts',
    literal: "'guest-error'",
  },
] as const;

/**
 * Hyphenated Objective-C literals that are not refusal codes. `accessibility-error` keys the native
 * AX error number in an `NSError` `userInfo`.
 */
const NON_CODE_LITERALS: ReadonlySet<string> = new Set(['accessibility-error']);

function emittedCodes(): Map<string, string> {
  const emitted = new Map<string, string>();
  const add = (code: string, file: string) => {
    if (!emitted.has(code)) emitted.set(code, file);
  };
  for (const file of [...filesIn('apple/snapshot-bridge', '.m'), RUNNER_OBJC]) {
    for (const [, code] of read(file).matchAll(/@"([a-z0-9]+(?:-[a-z0-9]+)+)"/g)) {
      if (!NON_CODE_LITERALS.has(code!)) add(code!, file);
    }
  }
  for (const [, code] of read(RUNNER_SWIFT).matchAll(/"error_code":\s*"([a-z0-9-]+)"/g)) {
    add(code!, RUNNER_SWIFT);
  }
  const typescriptSources = [
    ...filesIn('packages/platform-apple/src/snapshot-source', '.ts'),
    'packages/platform-apple/src/runner-snapshot-bridge.ts',
  ];
  for (const file of typescriptSources) {
    for (const [, code] of read(file).matchAll(
      /snapshotSourceError\(\s*'[a-z-]+',\s*'([a-z0-9-]+)'/g,
    )) {
      add(code!, file);
    }
  }
  for (const { code, file, literal } of DEFAULT_CODE_LITERALS) {
    assert.ok(read(file).includes(literal), `${file} no longer carries ${literal}`);
    add(code, file);
  }
  return emitted;
}

test('every refusal code a bridge emitter writes is classified in the fixture', () => {
  const unclassified = [...emittedCodes()].filter(([code]) => !fixtureCodes.includes(code));
  expect(
    unclassified.map(([code, file]) => `${code} (${file})`),
    'classify each code in contracts/fixtures/ios-snapshot-bridge-refusals.json',
  ).toEqual([]);
});

test('every refusal code in the fixture is emitted by a bridge source', () => {
  const emitted = emittedCodes();
  expect(fixtureCodes.filter((code) => !emitted.has(code))).toEqual([]);
  expect(new Set(fixtureCodes).size).toBe(fixtureCodes.length);
});
