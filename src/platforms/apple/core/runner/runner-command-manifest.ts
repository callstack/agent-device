import type { RunnerCommand } from './runner-contract.ts';

export type RunnerCommandTraitClass =
  | 'default'
  | 'readOnly'
  | 'readOnlyReadinessProbe'
  | 'preflightSkippableTouchMutation';

export const RUNNER_COMMAND_TRAIT_MANIFEST = {
  tap: 'preflightSkippableTouchMutation',
  mouseClick: 'default',
  longPress: 'preflightSkippableTouchMutation',
  drag: 'preflightSkippableTouchMutation',
  remotePress: 'default',
  type: 'default',
  swipe: 'preflightSkippableTouchMutation',
  scroll: 'preflightSkippableTouchMutation',
  desktopScroll: 'preflightSkippableTouchMutation',
  findText: 'readOnly',
  querySelector: 'readOnly',
  readText: 'readOnly',
  snapshot: 'readOnly',
  screenshot: 'readOnly',
  back: 'default',
  backInApp: 'default',
  backSystem: 'default',
  home: 'default',
  rotate: 'default',
  rotateGesture: 'default',
  transformGesture: 'default',
  appSwitcher: 'default',
  keyboardDismiss: 'default',
  keyboardReturn: 'default',
  alert: 'readOnly',
  pinch: 'default',
  sequence: 'preflightSkippableTouchMutation',
  recordStart: 'default',
  recordStop: 'default',
  status: 'readOnlyReadinessProbe',
  uptime: 'readOnlyReadinessProbe',
  shutdown: 'default',
} as const satisfies Record<RunnerCommand['command'], RunnerCommandTraitClass>;
