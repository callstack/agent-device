import { PUBLIC_COMMANDS } from '../../../src/command-catalog.ts';
import type { AndroidEmulatorBehaviorId } from './behavior-coverage.ts';
import { assertAutomationSystem } from './live-automation-scenario.ts';
import { installCachedFixture } from './live-bootstrap.ts';
import { assertCaptureAndClose } from './live-capture-scenario.ts';
import { assertFormInput, assertKeyboardIme } from './live-form-scenario.ts';
import type { LiveContext } from './live-harness.ts';
import { assertInventoryAndInstall } from './live-inventory-scenario.ts';
import { assertLifecycleAndSystem } from './live-lifecycle-scenario.ts';
import { assertObservabilityAndArtifacts } from './live-observability-scenario.ts';
import { assertFixtureReplays } from './live-replay-scenarios.ts';
import type { AndroidEmulatorScenarioStart } from './scenario-start.ts';

const C = PUBLIC_COMMANDS;
const AUTOMATION_DEEP_LINK =
  'agent-device-test-app:///automation?event=cold.start&payload=%7B%22source%22%3A%22android-deep-link%22%7D';

export type AndroidEmulatorScenario = {
  behaviors: readonly AndroidEmulatorBehaviorId[];
  commands: readonly string[];
  id: string;
  run: (context: LiveContext) => Promise<void>;
  start?: AndroidEmulatorScenarioStart;
  tier?: 'smoke' | 'full';
};

export const ANDROID_EMULATOR_FIXTURE_BOOTSTRAP: AndroidEmulatorScenario = {
  behaviors: [],
  commands: [C.install],
  id: 'smoke:fixture-bootstrap',
  run: installCachedFixture,
};

export const ANDROID_EMULATOR_LIVE_SCENARIOS = [
  {
    behaviors: [],
    commands: [C.devices, C.capabilities, C.apps, C.doctor],
    id: 'smoke:inventory',
    run: assertInventoryAndInstall,
  },
  {
    behaviors: [
      'android-resource-id-selectors',
      'cold-start-deep-link-navigation',
      'home-recents-restoration',
      'orientation-fixture-state',
      'safe-back-navigation',
    ],
    commands: [
      C.alert,
      C.appSwitcher,
      C.appState,
      C.back,
      C.click,
      C.diff,
      C.find,
      C.get,
      C.home,
      C.is,
      C.longPress,
      C.open,
      C.orientation,
      C.press,
      C.snapshot,
      C.wait,
    ],
    id: 'smoke:automation-system',
    run: assertAutomationSystem,
    start: {
      ime: 'system',
      landmark: 'Automation lab',
      url: AUTOMATION_DEEP_LINK,
    },
  },
  {
    behaviors: ['test-ime-restoration', 'test-ime-unicode-input'],
    commands: [C.fill, C.focus, C.type],
    id: 'smoke:form-input',
    run: assertFormInput,
    start: {
      ime: 'test',
      landmark: 'Checkout form',
      url: 'agent-device-test-app:///form',
    },
  },
  {
    behaviors: ['safe-keyboard-dismissal', 'system-ime-keyboard'],
    commands: [C.keyboard],
    id: 'smoke:keyboard-ime',
    run: assertKeyboardIme,
    start: {
      ime: 'system',
      landmark: 'Checkout form',
      url: 'agent-device-test-app:///form',
    },
  },
  {
    behaviors: [],
    commands: [C.close, C.screenshot],
    id: 'smoke:capture-close',
    run: assertCaptureAndClose,
    start: {
      ime: 'system',
      landmark: 'Agent Device Tester',
      url: 'agent-device-test-app:///',
    },
  },
  {
    behaviors: [
      'ime-owned-input-recovery',
      'push-broadcast-delivery',
      'runtime-permission-recovery',
    ],
    commands: [C.push, C.settings],
    id: 'full:lifecycle-system',
    run: assertLifecycleAndSystem,
    tier: 'full',
  },
  {
    behaviors: [],
    commands: [C.artifacts, C.batch, C.events, C.logs, C.perf, C.record, C.trace],
    id: 'full:observability-artifacts',
    run: assertObservabilityAndArtifacts,
    tier: 'full',
  },
  {
    behaviors: ['helper-backed-gesture-recovery', 'long-list-scroll-recovery'],
    commands: [C.gesture, C.replay, C.scroll, C.swipe, C.test],
    id: 'full:fixture-replays',
    run: assertFixtureReplays,
    tier: 'full',
  },
] as const satisfies readonly AndroidEmulatorScenario[];

export type AndroidEmulatorScenarioId = (typeof ANDROID_EMULATOR_LIVE_SCENARIOS)[number]['id'];

export function selectAndroidEmulatorScenarios(
  requestedIds?: readonly string[],
): readonly AndroidEmulatorScenario[] {
  if (requestedIds === undefined) return ANDROID_EMULATOR_LIVE_SCENARIOS;
  if (requestedIds.length === 0) {
    throw new Error('select at least one Android emulator E2E scenario');
  }
  const byId = new Map(ANDROID_EMULATOR_LIVE_SCENARIOS.map((scenario) => [scenario.id, scenario]));
  const selected: AndroidEmulatorScenario[] = [];
  const seen = new Set<string>();
  for (const id of requestedIds) {
    if (seen.has(id)) throw new Error(`duplicate Android emulator E2E scenario: ${id}`);
    const scenario = byId.get(id as AndroidEmulatorScenarioId);
    if (!scenario) throw new Error(`unknown Android emulator E2E scenario: ${id}`);
    seen.add(id);
    selected.push(scenario);
  }
  return selected;
}
