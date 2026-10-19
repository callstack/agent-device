import fs from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { parse } from 'yaml';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import { selectAppleBridgeProof, selectIosSmoke, selectIosXctests } from '../apple-ci-impact.ts';
import { selectChecks } from '../check-affected/model.ts';

const repoRoot = path.resolve(import.meta.dirname, '../..');

type AppleStep = {
  id?: string;
  uses?: string;
  if?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, string>;
  'continue-on-error'?: boolean;
};

function appleJob() {
  const doc = parse(
    fs.readFileSync(path.join(repoRoot, '.github/workflows/apple.yml'), 'utf8'),
  ) as {
    jobs: Record<string, { steps: AppleStep[] }>;
  };
  expect(Object.keys(doc.jobs)).toHaveLength(1);
  return Object.values(doc.jobs)[0]!;
}

test('Apple smoke shares setup and build while keeping platform state and native products separate', () => {
  const { steps } = appleJob();
  expect(steps.filter((step) => step.uses?.startsWith('actions/checkout@'))).toHaveLength(1);
  expect(steps.filter((step) => step.uses === './.github/actions/setup-node-pnpm')).toHaveLength(1);
  expect(steps.filter((step) => step.with?.gate === 'build')).toHaveLength(1);
  const ios = steps.find((step) => step.id === 'ios')!;
  const macos = steps.find((step) => step.id === 'macos')!;
  expect(ios.uses).toBe('./.github/actions/smoke-ios');
  expect(macos.uses).toBe('./.github/actions/smoke-macos');
  expect(steps.indexOf(ios)).toBeLessThan(steps.indexOf(macos));
  for (const variable of ['AGENT_DEVICE_STATE_DIR', 'AGENT_DEVICE_IOS_RUNNER_DERIVED_PATH']) {
    expect(ios.env?.[variable]).toBeTruthy();
    expect(macos.env?.[variable]).toBeTruthy();
    expect(ios.env?.[variable]).not.toBe(macos.env?.[variable]);
  }
  for (const phase of [ios, macos]) {
    expect(phase['continue-on-error']).toBe(true);
    const cleanup = steps.find((step) => step.id === `${phase.id}-cleanup`)!;
    expect(steps.indexOf(cleanup)).toBeGreaterThan(steps.indexOf(phase));
    if (phase === ios) expect(steps.indexOf(cleanup)).toBeLessThan(steps.indexOf(macos));
    expect(cleanup.if).toContain('always()');
    expect(cleanup['continue-on-error']).toBe(true);
    expect(cleanup.env?.AGENT_DEVICE_STATE_DIR).toBe(phase.env?.AGENT_DEVICE_STATE_DIR);
    expect(cleanup.run?.trim()).toBe('pnpm clean:daemon');
  }
});

test('the workflow resolves the optional physical device variable before entering composites', () => {
  const ios = appleJob().steps.find((step) => step.id === 'ios')!;
  expect(ios.env?.IOS_UDID).toBe('${{ vars.IOS_UDID }}');
  for (const action of ['smoke-ios', 'smoke-ios-run']) {
    const source = fs.readFileSync(
      path.join(repoRoot, `.github/actions/${action}/action.yml`),
      'utf8',
    );
    expect(source).not.toMatch(/\$\{\{\s*vars\./);
  }
});

test('Apple uploads shared diagnostics once and retains both platform logs after cleanup', () => {
  const { steps } = appleJob();
  const uploads = steps.filter(
    (step) => step.uses === './.github/actions/upload-agent-device-artifacts',
  );
  expect(uploads).toHaveLength(1);
  const upload = uploads[0]!;
  expect(upload.if).toBe('always()');
  for (const platform of ['ios', 'macos']) {
    const phase = steps.find((step) => step.id === platform)!;
    const cleanup = steps.find((step) => step.id === `${platform}-cleanup`)!;
    expect(steps.indexOf(upload)).toBeGreaterThan(steps.indexOf(cleanup));
    const state = phase.env!.AGENT_DEVICE_STATE_DIR!;
    const derived = phase.env!.AGENT_DEVICE_IOS_RUNNER_DERIVED_PATH!;
    if (platform === 'ios') {
      expect(upload.with?.['agent-state-dir']).toBe(state);
      expect(upload.with?.['runner-derived-path']).toBe(derived);
    } else {
      expect(upload.with?.['additional-paths']?.trim().split(/\r?\n/)).toEqual([
        `${state}/daemon.log`,
        `${state}/sessions/**`,
        `${derived}/.agent-device-runner-cache.json`,
        `${derived}/Logs/**`,
      ]);
    }
    const action = fs.readFileSync(
      path.join(
        repoRoot,
        `.github/actions/smoke-${platform === 'ios' ? 'ios-run' : platform}/action.yml`,
      ),
      'utf8',
    );
    expect(action).not.toContain('./.github/actions/upload-agent-device-artifacts');
  }
  const helper = parse(
    fs.readFileSync(
      path.join(repoRoot, '.github/actions/upload-agent-device-artifacts/action.yml'),
      'utf8',
    ),
  ) as { inputs: Record<string, { default?: string }>; runs: { steps: AppleStep[] } };
  expect(helper.inputs['additional-paths']?.default).toBe('');
  const paths = helper.runs.steps[0]!.with!.path!;
  for (const path of [
    'test/artifacts/**',
    'test/screenshots/**',
    '~/.agent-device/logs/**',
    '${{ inputs.additional-paths }}',
  ]) {
    expect(paths.split(/\r?\n/).filter((entry) => entry === path)).toHaveLength(1);
  }
});

test.each([
  ['all successful', {}, 0],
  ['iOS fails', { IOS_OUTCOME: 'failure' }, 1],
  ['macOS fails', { MACOS_OUTCOME: 'failure' }, 1],
  ['iOS silently skipped', { IOS_OUTCOME: 'skipped' }, 1],
  ['macOS silently skipped', { MACOS_OUTCOME: 'skipped' }, 1],
  ['iOS cleanup fails', { IOS_CLEANUP_OUTCOME: 'failure' }, 1],
  ['macOS cleanup fails', { MACOS_CLEANUP_OUTCOME: 'failure' }, 1],
] as const)('the final Apple status guard preserves failure: %s', (_label, overrides, expected) => {
  const guard = appleJob().steps.find((step) => step.env?.IOS_OUTCOME)!;
  expect(guard.if).toBe('always()');
  expect(guard.env).toEqual({
    IOS_OUTCOME: '${{ steps.ios.outcome }}',
    MACOS_OUTCOME: '${{ steps.macos.outcome }}',
    IOS_CLEANUP_OUTCOME: '${{ steps.ios-cleanup.outcome }}',
    MACOS_CLEANUP_OUTCOME: '${{ steps.macos-cleanup.outcome }}',
  });
  const result = spawnSync('/bin/bash', ['-c', guard.run!], {
    env: {
      ...process.env,
      IOS_OUTCOME: 'success',
      MACOS_OUTCOME: 'success',
      IOS_CLEANUP_OUTCOME: 'success',
      MACOS_CLEANUP_OUTCOME: 'success',
      ...overrides,
      GITHUB_STEP_SUMMARY: path.join(mkdtempForTestSync('apple-smoke-status-'), 'summary.md'),
    },
    encoding: 'utf8',
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(expected);
});

test('the iOS composite uses its guarded route and skips only its nested simulator work', () => {
  const doc = parse(
    fs.readFileSync(path.join(repoRoot, '.github/actions/smoke-ios/action.yml'), 'utf8'),
  ) as {
    inputs: { 'paths-ignore': { default: string } };
    runs: { steps: AppleStep[] };
  };
  const select = doc.runs.steps.find((step) => step.id === 'impact')!;
  expect(select.run).toContain('scripts/apple-ci-impact.ts smoke');
  expect(select.env?.IOS_SMOKE_PATHS_IGNORE).toBe('${{ inputs.paths-ignore }}');
  const run = doc.runs.steps.find((step) => step.uses === './.github/actions/smoke-ios-run')!;
  expect(run.if).toBe("steps.impact.outputs.run != 'false'");
  const ignored = doc.inputs['paths-ignore'].default.split(/\r?\n/).filter(Boolean);
  for (const file of [
    'src/foo.test.ts',
    'packages/platform-android/src/index.ts',
    'test/integration/replays/macos/basic.ad',
  ]) {
    expect(selectIosSmoke('pull_request', [file], ignored).run, file).toBe(false);
  }
  for (const file of [
    'packages/platform-apple/src/index.ts',
    'src/index.ts',
    '.github/actions/smoke-ios/action.yml',
  ]) {
    expect(selectIosSmoke('pull_request', [file], ignored).run, file).toBe(true);
  }
  expect(selectIosSmoke('pull_request', ['src/foo.test.ts', 'src/index.ts'], ignored).run).toBe(
    true,
  );
  expect(selectIosSmoke('pull_request', null, ignored).run).toBe(true);
  expect(selectIosSmoke('pull_request', [], ignored).run).toBe(true);
  expect(selectIosSmoke('push', ['src/foo.test.ts'], ignored).run).toBe(true);
});

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
  const doc = parse(workflow) as {
    jobs?: Record<string, { steps?: WorkflowStep[] }>;
    runs?: { steps?: WorkflowStep[] };
  };
  return (
    doc.runs?.steps ?? Object.values(doc.jobs ?? {}).flatMap((job) => job.steps ?? [])
  ).findIndex(matches);
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

function appleRunnerBuildAction(): {
  text: string;
  steps: AppleRunnerBuildStep[];
  inputs: Record<string, { required?: boolean; default?: string }>;
} {
  const action = fs.readFileSync(
    path.join(repoRoot, '.github/actions/setup-apple-runner-build/action.yml'),
    'utf8',
  );
  const doc = parse(action) as {
    inputs?: Record<string, { required?: boolean; default?: string }>;
    runs: { steps: AppleRunnerBuildStep[] };
  };
  return { text: action, steps: doc.runs.steps, inputs: doc.inputs ?? {} };
}

/**
 * The metadata writer resolves the build identity from these two values, so a job that omitted
 * them must be refused when it starts rather than at re-publish time, after a full build.
 */
test('the Apple runner build action requires the identity its metadata writer reads', () => {
  const { inputs } = appleRunnerBuildAction();
  expect(inputs['xcuitest-platform']).toEqual({
    required: true,
    description: expect.stringContaining('AGENT_DEVICE_XCUITEST_PLATFORM'),
  });
  expect(inputs['xcuitest-destination']).toEqual({
    required: true,
    description: expect.stringContaining('AGENT_DEVICE_XCUITEST_DESTINATION'),
  });
});

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
  // Restoring under a prefix would hand a job products whose content manifest belongs to
  // another identity, so the cache is exact-match only and the source hash must be in the key.
  expect(steps[restoreIndex]?.with?.key).toContain('steps.source-hash.outputs.value');
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
  const republishIndex = steps.findIndex(
    (step) => step.name === 'Re-publish Apple runner cache metadata',
  );
  expect(buildIndex).toBeGreaterThan(restoreIndex);
  expect(steps[buildIndex]?.if).toBeUndefined();
  expect(steps[buildIndex]?.env?.AGENT_DEVICE_XCUITEST_SKIP_ICON_PATCH).toBe('1');
  expect(saveIndex).toBeGreaterThan(buildIndex);
  expect(steps[saveIndex]?.if).toContain("cache-hit != 'true'");
  expect(patchIndex).toBeGreaterThan(saveIndex);
  expect(steps[patchIndex]?.if).toBeUndefined();
  expect(steps[patchIndex]?.run).toContain('scripts/patch-xcuitest-runner-icon.ts');
  // The cache is saved unpatched, so the manifest that ships inside it certifies unpatched
  // bytes. The tree that actually runs is republished after the patch rewrote those bytes.
  expect(republishIndex).toBeGreaterThan(patchIndex);
  expect(steps[republishIndex]?.run).toContain('scripts/write-xcuitest-cache-metadata.ts');
  expect(steps[republishIndex]?.run).toContain('agent-device-build-for-testing.log');
  expect(fs.readFileSync(path.join(repoRoot, 'scripts/build-xcuitest-apple.sh'), 'utf8')).toContain(
    'if ! is_truthy "${AGENT_DEVICE_XCUITEST_SKIP_ICON_PATCH:-}"; then',
  );
});

test('the PR workflow applies the impact decision to the XCTest step', () => {
  const workflow = fs.readFileSync(
    path.join(repoRoot, '.github/actions/smoke-ios-run/action.yml'),
    'utf8',
  );
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
  const workflow = fs.readFileSync(
    path.join(repoRoot, '.github/actions/smoke-macos/action.yml'),
    'utf8',
  );
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
    '.github/workflows/apple.yml',
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
    '.github/workflows/apple.yml',
  ]) {
    expect(selectAppleBridgeProof([file]).run, file).toBe(true);
  }
  expect(selectAppleBridgeProof(['src/index.ts']).run).toBe(false);
  expect(selectAppleBridgeProof(null).run).toBe(true);
  expect(selectAppleBridgeProof([]).run).toBe(true);
});

test('a shallow PR merge still yields a known change set for all Apple selectors', () => {
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
          env: {
            ...process.env,
            BASE_SHA: base,
            GITHUB_EVENT_NAME: 'pull_request',
            IOS_SMOKE_PATHS_IGNORE: 'src/**',
          },
        },
      );
    expect(select('xctest')).toContain('skip;');
    expect(select('bridge')).toContain('skip;');
    expect(select('smoke')).toContain('skip;');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
