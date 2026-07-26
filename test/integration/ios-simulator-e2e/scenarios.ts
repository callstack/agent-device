import { PUBLIC_COMMANDS } from '../../../src/command-catalog.ts';

export type IosSimulatorScenario = {
  commands: readonly string[];
  id: string;
  tier: 'smoke' | 'full';
};

const C = PUBLIC_COMMANDS;

export const IOS_SIMULATOR_LIVE_SCENARIOS: readonly IosSimulatorScenario[] = [
  {
    id: 'smoke:inventory-install',
    tier: 'smoke',
    commands: [C.devices, C.capabilities, C.doctor, C.install, C.apps],
  },
  {
    id: 'smoke:automation-input',
    tier: 'smoke',
    commands: [
      C.open,
      C.snapshot,
      C.wait,
      C.get,
      C.is,
      C.find,
      C.click,
      C.press,
      C.longPress,
      C.alert,
      C.back,
    ],
  },
  {
    id: 'smoke:form-input',
    tier: 'smoke',
    commands: [C.fill, C.focus, C.type, C.keyboard, C.diff],
  },
  {
    id: 'smoke:capture-close',
    tier: 'smoke',
    commands: [C.screenshot, C.close],
  },
  {
    id: 'full:lifecycle-system',
    tier: 'full',
    commands: [
      C.appState,
      C.home,
      C.appSwitcher,
      C.clipboard,
      C.orientation,
      C.settings,
      C.triggerAppEvent,
    ],
  },
  {
    id: 'full:observability-artifacts',
    tier: 'full',
    commands: [C.perf, C.logs, C.record, C.trace, C.events, C.batch, C.reactNative],
  },
  {
    id: 'full:fixture-replays',
    tier: 'full',
    commands: [C.gesture, C.scroll, C.swipe, C.replay, C.test],
  },
  {
    id: 'full:device-lifecycle',
    tier: 'full',
    commands: [C.reinstall, C.shutdown, C.boot],
  },
  {
    id: 'full:known-gaps',
    tier: 'full',
    commands: [C.viewport],
  },
] as const;
