import { PUBLIC_COMMANDS } from '../../../src/command-catalog.ts';
import type { AndroidEmulatorBehaviorId } from './behavior-coverage.ts';
import { assertAutomationSystem } from './live-automation-scenario.ts';
import { assertCaptureAndClose } from './live-capture-scenario.ts';
import { assertFormInput, assertKeyboardIme } from './live-form-scenario.ts';
import type { LiveContext } from './live-harness.ts';
import { assertInventoryAndInstall } from './live-inventory-scenario.ts';

const C = PUBLIC_COMMANDS;

export type AndroidEmulatorScenario = {
  behaviors: readonly AndroidEmulatorBehaviorId[];
  commands: readonly string[];
  id: string;
  run: (context: LiveContext) => Promise<void>;
};

export const ANDROID_EMULATOR_LIVE_SCENARIOS: readonly AndroidEmulatorScenario[] = [
  {
    behaviors: [],
    commands: [C.devices, C.capabilities, C.install, C.apps, C.doctor],
    id: 'smoke:inventory-install',
    run: assertInventoryAndInstall,
  },
  {
    behaviors: [
      'android-resource-id-selectors',
      'cold-start-deep-link-navigation',
      'home-recents-restoration',
      'orientation-fixture-state',
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
  },
  {
    behaviors: [],
    commands: [C.fill, C.focus, C.type],
    id: 'smoke:form-input',
    run: assertFormInput,
  },
  {
    behaviors: ['safe-keyboard-dismissal'],
    commands: [C.keyboard],
    id: 'smoke:keyboard-ime',
    run: assertKeyboardIme,
  },
  {
    behaviors: [],
    commands: [C.close, C.screenshot],
    id: 'smoke:capture-close',
    run: assertCaptureAndClose,
  },
];
