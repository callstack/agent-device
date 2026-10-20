import type { ReplayBackendHost } from '@agent-device/contracts/replay-backend';
import { resolveTargetDevice } from '@agent-device/device-selection/dispatch-resolve';
import { getRequestSignal } from '@agent-device/host-kit/request';
import { buildReplayBuiltinVars } from '../session-replay-vars.ts';
import { buildReplayBackendActionFailureResponse } from './replay-backend-failure.ts';
import { buildMaestroReplayTargetDeviceResolutionOptions } from './replay-script-selection.ts';
import {
  readReplayScriptSourceFile,
  REPLAY_SCRIPT_SOURCE_REQUIRED_MESSAGE,
} from './script-source.ts';
import { appendReplayTraceEvent } from './session-replay-trace.ts';

/**
 * The host services a replay backend plugin reaches (#3377): the process state and daemon
 * session policy it may not import. Built once per backend load by the registry.
 */
export function createReplayBackendHost(): ReplayBackendHost {
  return {
    appendTraceEvent: appendReplayTraceEvent,
    buildBuiltinVars: (params) => buildReplayBuiltinVars({ ...params, metadata: {} }),
    readScriptSourceFile: readReplayScriptSourceFile,
    scriptSourceRequiredMessage: REPLAY_SCRIPT_SOURCE_REQUIRED_MESSAGE,
    requestSignal: getRequestSignal,
    resolveTargetDevice: async (flags, binding, env) =>
      await resolveTargetDevice(
        flags,
        buildMaestroReplayTargetDeviceResolutionOptions(binding.appTarget, binding.platform, env),
      ),
    buildActionFailureResponse: buildReplayBackendActionFailureResponse,
  };
}
