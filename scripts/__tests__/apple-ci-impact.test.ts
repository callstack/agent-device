import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { parse } from 'yaml';
import { selectAppleBridgeProof, selectIosXctests } from '../apple-ci-impact.ts';
import { selectChecks } from '../check-affected/model.ts';

const repoRoot = path.resolve(import.meta.dirname, '../..');

function cacheInputs(action: string, stepId = 'source-hash'): string[] {
  const doc = parse(action) as { runs?: { steps?: Array<{ id?: string; run?: string }> } };
  const hashStep = doc.runs?.steps?.find((step) => step.id === stepId)?.run ?? '';
  const expressions = [...hashStep.matchAll(/hashFiles\(([\s\S]*?)\)/g)];
  expect(expressions.length).toBeGreaterThan(0);
  return expressions.flatMap((expression) =>
    [...expression[1]!.matchAll(/'([^']+)'/g)].map((match) => match[1]!),
  );
}

type WorkflowStep = { run?: string; with?: { gate?: string } };

/**
 * Index of the first workflow step matching a predicate, counted across every job in file order,
 * or -1. Steps are located by the command they run or the gate they invoke rather than by their
 * title, and through the same YAML parser the assertions below already use, so a step renamed for
 * scope reasons — or a `run:` block reindented — is not mistaken for a sequencing regression.
 */
function workflowStepIndex(workflow: string, matches: (step: WorkflowStep) => boolean): number {
  const doc = parse(workflow) as { jobs?: Record<string, { steps?: WorkflowStep[] }> };
  return Object.values(doc.jobs ?? {})
    .flatMap((job) => job.steps ?? [])
    .findIndex(matches);
}

test('native runner build-cache inputs trigger the PR XCTest lane', () => {
  const action = fs.readFileSync(
    path.join(repoRoot, '.github/actions/setup-apple-runner-build/action.yml'),
    'utf8',
  );
  expect(cacheInputs(action).filter((input) => input.startsWith('packages/'))).toEqual([]);
  expect(cacheInputs(action).filter((input) => input.endsWith('.ts'))).toEqual([]);
  const uncovered = (text: string) =>
    cacheInputs(text)
      .filter((input) => !input.startsWith('!'))
      .filter((input) => {
        const path = input.replace(/\*\*?$/, 'probe.ts');
        const plan = selectChecks({ changedFiles: [path] });
        return !plan.failOpen && !plan.checks.includes('swift-runner-ios');
      });
  expect(uncovered(action)).toEqual([]);
  expect(
    uncovered(action.replace('apple/runner/**', 'packages/platform-apple/src/snapshot-source/**')),
  ).toEqual(['packages/platform-apple/src/snapshot-source/**']);
  expect(
    uncovered(
      action.replace(
        'hashFiles(',
        "hashFiles('packages/platform-apple/src/foldable/**',\n          ",
      ),
    ),
  ).toEqual(['packages/platform-apple/src/foldable/**']);
});

type AppleRunnerBuildStep = {
  id?: string;
  name?: string;
  env?: Record<string, string>;
  if?: string;
  run?: string;
  with?: Record<string, string>;
};

function appleRunnerBuildAction(): { text: string; steps: AppleRunnerBuildStep[] } {
  const action = fs.readFileSync(
    path.join(repoRoot, '.github/actions/setup-apple-runner-build/action.yml'),
    'utf8',
  );
  const doc = parse(action) as {
    runs: { steps: AppleRunnerBuildStep[] };
  };
  return { text: action, steps: doc.runs.steps };
}

test('Apple runner build cache uses only declared source and schema hashes', () => {
  const { text, steps } = appleRunnerBuildAction();
  const restoreIndex = steps.findIndex((step) => step.name === 'Restore Apple runner build cache');
  expect(steps.filter((step) => step.run?.includes('hashFiles(')).map((step) => step.id)).toEqual([
    'source-hash',
    'cache-schema',
  ]);
  expect(cacheInputs(text, 'cache-schema')).toEqual([
    '.github/actions/setup-apple-runner-build/action.yml',
    'scripts/build-xcuitest-apple.sh',
  ]);
  expect(steps[restoreIndex]?.with?.key).toContain('steps.cache-schema.outputs.value');
  expect(steps[restoreIndex]?.with?.['restore-keys']).toBeUndefined();
  expect(cacheInputs(text)).not.toContain('scripts/patch-xcuitest-runner-icon.ts');
});

test('restored native products are rebuilt before caching and icon patching', () => {
  const { steps } = appleRunnerBuildAction();
  const restoreIndex = steps.findIndex((step) => step.name === 'Restore Apple runner build cache');
  const buildIndex = steps.findIndex(
    (step) => step.name === 'Verify Apple runner artifacts with Xcode',
  );
  const saveIndex = steps.findIndex((step) => step.name === 'Save Apple runner build cache');
  const patchIndex = steps.findIndex((step) => step.name === 'Patch XCTest runner icon');
  expect(buildIndex).toBeGreaterThan(restoreIndex);
  expect(steps[buildIndex]?.if).toBeUndefined();
  expect(steps[buildIndex]?.env?.AGENT_DEVICE_XCUITEST_SKIP_ICON_PATCH).toBe('1');
  expect(saveIndex).toBeGreaterThan(buildIndex);
  expect(steps[saveIndex]?.if).toContain("cache-hit != 'true'");
  expect(patchIndex).toBeGreaterThan(saveIndex);
  expect(steps[patchIndex]?.if).toBeUndefined();
  expect(steps[patchIndex]?.run).toContain('scripts/patch-xcuitest-runner-icon.ts');
  expect(fs.readFileSync(path.join(repoRoot, 'scripts/build-xcuitest-apple.sh'), 'utf8')).toContain(
    'if ! is_truthy "${AGENT_DEVICE_XCUITEST_SKIP_ICON_PATCH:-}"; then',
  );
});

test('the PR workflow applies the impact decision to the XCTest step', () => {
  const workflow = fs.readFileSync(path.join(repoRoot, '.github/workflows/ios.yml'), 'utf8');
  expect(workflow).toContain('node --experimental-strip-types scripts/apple-ci-impact.ts xctest');
  expect(workflow).toMatch(
    /- name: Run targeted iOS runner XCTest regressions\n\s+id: ios-xctest\n\s+if: steps\.xctest-impact\.outputs\.run != 'false'/,
  );
  expect(workflow).toContain('if [ "$SELECTED" = \'true\' ] && [ "$OUTCOME" = \'skipped\' ]');
});

test('macOS clean-install proof follows live UI replay', () => {
  // Ordered by what each step runs, not by its title: the clean-install proof must not fire
  // before the replay that can raise local-network permission UI, and a step renamed for scope
  // reasons is not a sequencing regression.
  const workflow = fs.readFileSync(path.join(repoRoot, '.github/workflows/macos.yml'), 'utf8');
  const replay = workflowStepIndex(workflow, (step) => step.with?.gate === 'replay-macos');
  const proof = workflowStepIndex(
    workflow,
    (step) => step.run?.includes('--verify-snapshot-bridge-preparation') ?? false,
  );
  expect(replay).toBeGreaterThan(-1);
  expect(proof).toBeGreaterThan(replay);
  expect(workflow).toContain('node --experimental-strip-types scripts/apple-ci-impact.ts bridge');
  expect(workflow).toContain("steps.bridge-impact.outputs.run != 'false'");
});

test('native runner and golden-table changes run XCTest; TypeScript runtime changes use live E2E', () => {
  for (const file of [
    'apple/runner/AgentDeviceRunner/AgentDeviceRunnerUITests/RunnerTests.swift',
    'apple/snapshot-presentation/Sources/Presenter.swift',
    'packages/platform-apple/src/runner/runner-icon.ts',
    'contracts/fixtures/scroll-gesture.json',
    '.github/workflows/ios.yml',
    'scripts/apple-ci-impact.ts',
  ]) {
    expect(selectIosXctests('pull_request', [file]).run, file).toBe(true);
  }
  for (const file of [
    'packages/platform-apple/src/snapshot-source/cache.ts',
    'packages/platform-apple/src/runner/__tests__/runner-icon.test.ts',
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

test('bridge proof runs for its owning sources and uncertain tooling changes', () => {
  for (const file of [
    'apple/snapshot-bridge/Bridge.c',
    'apple/fold-helper/Helper.c',
    'apple/new-native-module/Source.m',
    'packages/platform-apple/src/snapshot-source/native-runtime.ts',
    'packages/platform-apple/src/foldable/fold-helper-cache.ts',
    'packages/platform-apple/src/new-module/runtime.ts',
    'scripts/check-package.ts',
    '.github/workflows/macos.yml',
  ]) {
    expect(selectAppleBridgeProof([file]).run, file).toBe(true);
  }
  expect(selectAppleBridgeProof(['src/index.ts']).run).toBe(false);
  expect(selectAppleBridgeProof(null).run).toBe(true);
  expect(selectAppleBridgeProof([]).run).toBe(true);
});

test('a shallow PR merge still yields a known change set for both selectors', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apple-ci-impact-'));
  const source = path.join(root, 'source');
  const shallow = path.join(root, 'shallow');
  fs.mkdirSync(source);
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  try {
    git(source, 'init', '-q', '-b', 'main');
    git(source, 'config', 'user.email', 'test@example.com');
    git(source, 'config', 'user.name', 'Test');
    git(source, 'commit', '--allow-empty', '-qm', 'base');
    const base = git(source, 'rev-parse', 'HEAD');
    git(source, 'checkout', '-qb', 'feature');
    fs.mkdirSync(path.join(source, 'src'));
    fs.writeFileSync(path.join(source, 'src', 'feature.ts'), 'export const feature = true;\n');
    git(source, 'add', '.');
    git(source, 'commit', '-qm', 'feature');
    git(source, 'checkout', '-q', 'main');
    git(source, 'merge', '-q', '--no-ff', '-m', 'merge', 'feature');
    git(root, 'clone', '-q', '--depth=1', '--branch', 'main', `file://${source}`, shallow);
    git(shallow, 'fetch', '-q', 'origin', base, '--depth=1');
    expect(git(shallow, 'rev-parse', '--is-shallow-repository')).toBe('true');
    const select = (target: string) =>
      execFileSync(
        process.execPath,
        ['--experimental-strip-types', path.join(repoRoot, 'scripts/apple-ci-impact.ts'), target],
        {
          cwd: shallow,
          encoding: 'utf8',
          env: { ...process.env, BASE_SHA: base, GITHUB_EVENT_NAME: 'pull_request' },
        },
      );
    expect(select('xctest')).toContain('skip;');
    expect(select('bridge')).toContain('skip;');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
