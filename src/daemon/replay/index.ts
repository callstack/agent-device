/** Public replay application seam for daemon handlers and their admitted owner capabilities. */
export { runReplayCommand } from './internal/native-command.ts';
export { runReplayTestCommand } from './internal/test-command.ts';
export type {
  ReplayCoordinator,
  ReplayDaemonDependencies,
  ReplayDispatchRequest,
  ReplayInvoke,
  ReplayResumeStamper,
  ReplaySession,
  ReplaySessionView,
  ReplayTestVideoOwner,
} from './internal/command-types.ts';
export { healedScriptSiblingPath } from './internal/session-replay-heal.ts';
export {
  appTargetResolutionOptions,
  buildMaestroReplayTargetDeviceResolutionOptions,
  buildReplayScriptPlatformFlags,
  readScriptReplaySelection,
} from './internal/replay-script-selection.ts';
