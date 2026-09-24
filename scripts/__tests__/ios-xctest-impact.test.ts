import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import {
  affectsIosXctests,
  selectIosXctests,
  uncoveredRunnerCacheInputs,
} from '../ios-xctest-impact.ts';

test('every runner build-cache input triggers the PR XCTest lane', () => {
  const action = fs.readFileSync(
    path.resolve('.github/actions/setup-apple-runner-build/action.yml'),
    'utf8',
  );
  expect(uncoveredRunnerCacheInputs(action)).toEqual([]);
  expect(
    uncoveredRunnerCacheInputs(action.replace('apple/runner/**', 'new-native-input/**')),
  ).toEqual(['new-native-input/**']);
});

test('the PR workflow applies the impact decision to the XCTest step', () => {
  const workflow = fs.readFileSync(path.resolve('.github/workflows/ios.yml'), 'utf8');
  expect(workflow).toContain('node --experimental-strip-types scripts/ios-xctest-impact.ts');
  expect(workflow).toMatch(
    /- name: Run targeted iOS runner XCTest regressions\n\s+if: steps\.xctest-impact\.outputs\.run == 'true'/,
  );
});

test('macOS clean-install proof follows live UI replay', () => {
  const workflow = fs.readFileSync(path.resolve('.github/workflows/macos.yml'), 'utf8');
  const replay = workflow.indexOf('- name: Run macOS integration test');
  const proof = workflow.indexOf(
    '- name: Verify clean-installed Simulator snapshot bridge preparation',
  );
  expect(replay).toBeGreaterThan(-1);
  expect(proof).toBeGreaterThan(replay);
});

test('native runner and golden-table changes run XCTest; TypeScript runtime changes use live E2E', () => {
  for (const file of [
    'apple/runner/AgentDeviceRunner/AgentDeviceRunnerUITests/RunnerTests.swift',
    'apple/snapshot-presentation/Sources/Presenter.swift',
    'contracts/fixtures/scroll-gesture.json',
    '.github/workflows/ios.yml',
    'scripts/ios-xctest-impact.ts',
  ]) {
    expect(affectsIosXctests(file), file).toBe(true);
  }
  for (const file of [
    'packages/platform-apple/src/snapshot-source/cache.ts',
    'apple/fold-helper/fold-helper.c',
    'test/integration/ios-simulator-e2e/live-runner.ts',
  ]) {
    expect(selectIosXctests('pull_request', [file]), file).toMatchObject({ run: false });
  }
});

test('pushes and uncertain diffs keep the full XCTest selection', () => {
  expect(selectIosXctests('push', ['src/index.ts']).run).toBe(true);
  expect(selectIosXctests('pull_request', null).run).toBe(true);
  expect(selectIosXctests('pull_request', []).run).toBe(true);
  expect(selectIosXctests('pull_request', ['src/index.ts', 'package.json']).run).toBe(true);
});
