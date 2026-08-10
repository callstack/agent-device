// A representative path per affected-selector category.
//
// selector-rules.ts derives WHICH categories exist; this supplies a path that exercises each,
// which is the only part a machine cannot infer — the selector maps paths to rules, not rules
// back to paths. The list is therefore checked rather than trusted: `unrepresentedRules` fails
// when the selector grows a rule no sample here reaches, so it cannot quietly fall behind.

import type { PathCategory } from './path-categories.ts';
import type { CheckPlan, SelectInput } from '../check-affected/model.ts';

const PATH_CATEGORY_SAMPLES: readonly {
  label: string;
  path: string;
  packageEntryFiles?: readonly string[];
}[] = [
  { label: 'production source', path: 'src/commands/batch/index.ts' },
  { label: 'platform source', path: 'src/platforms/android/adb.ts' },
  { label: 'workspace package source', path: 'packages/kernel/src/errors.ts' },
  { label: 'platform package source', path: 'packages/platform-android/src/index.ts' },
  { label: 'node integration test', path: 'test/integration/smoke-cli.test.ts' },
  {
    label: 'Swift runner source',
    path: 'apple/runner/AgentDeviceRunner/AgentDeviceRunnerUITests/RunnerTapPointPolicy.swift',
  },
  {
    label: 'Android helper source',
    path: 'android/snapshot-helper/src/main/java/com/callstack/agentdevice/snapshothelper/AccessibilityTreeCapture.java',
  },
  {
    label: 'macOS helper source',
    path: 'apple/macos-helper/Sources/AgentDeviceMacOSHelper/AudioProbe.swift',
  },
  { label: 'MCP registry metadata', path: 'server.json' },
  { label: 'Expo test app', path: 'examples/test-app/app/(tabs)/audio.tsx' },
  {
    label: 'replay-compat corpus',
    path: 'test/replay-compat/scripts/docs/context-header-conflicting-platform.v0.15.1.ad',
  },
  { label: 'replay-compat fixture', path: 'test/replay-compat/corpus.test.ts' },
  // A wire-surface file under `packages/` already reaches this rule, but only incidentally —
  // it is some other category's sample. Naming the ledger directory directly is what puts
  // `test/wire-compat/**` itself under the path-filter reachability assertion.
  { label: 'daemon wire ledger', path: 'test/wire-compat/surface.ts' },
  // The public entry surface is only a category when the selector is told which files are
  // published entries, so this sample supplies that input the way `check:affected` does.
  {
    label: 'published package entry',
    path: 'src/sdk/index.ts',
    packageEntryFiles: ['src/sdk/index.ts'],
  },
];

/** Runs each sample through the live selector, recording the checks and rules it produced. */
export function deriveCategories(select: (input: SelectInput) => CheckPlan): PathCategory[] {
  return PATH_CATEGORY_SAMPLES.map((sample) => {
    const plan = select({
      changedFiles: [sample.path],
      ...(sample.packageEntryFiles ? { packageEntryFiles: sample.packageEntryFiles } : {}),
    });
    return {
      label: sample.label,
      path: sample.path,
      // A fail-open sample would demand every check reach every path, which is not the claim
      // being tested; check.ts asserts separately that the samples still classify.
      checks: plan.failOpen ? [] : plan.checks,
      rules: plan.failOpen ? [] : [...new Set(plan.reasons.map((reason) => reason.rule))],
    };
  });
}
