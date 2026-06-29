import { asAppError } from '../../kernel/errors.ts';
import type { ReplayVarScope } from '../../replay/vars.ts';
import type { DaemonInvokeFn, DaemonResponse } from '../../daemon/types.ts';
import { executeRunScriptFile } from './run-script.ts';
import { MAESTRO_RUNTIME_COMMAND } from './runtime-commands.ts';
import {
  invokeMaestroAssertNotVisible,
  invokeMaestroAssertVisible,
  invokeMaestroWaitForAnimationToEnd,
} from './runtime-assertions.ts';
import {
  errorResponse,
  type MaestroReplayInvoker,
  type MaestroRuntimeInvoke,
  type ReplayBaseRequest,
} from './runtime-support.ts';
import {
  invokeMaestroScrollUntilVisible,
  invokeMaestroSwipeScreen,
  invokeMaestroSwipeOn,
  invokeMaestroTapOn,
  invokeMaestroTapPointPercent,
} from './runtime-interactions.ts';

export async function invokeMaestroRuntimeCommand(params: {
  command: string;
  baseReq: ReplayBaseRequest;
  positionals: string[];
  scope: ReplayVarScope;
  line: number;
  step: number;
  invoke: DaemonInvokeFn;
  invokeReplayAction: MaestroReplayInvoker;
}): Promise<DaemonResponse | undefined> {
  switch (params.command) {
    case MAESTRO_RUNTIME_COMMAND.assertVisible:
      return await invokeMaestroAssertVisible(params);
    case MAESTRO_RUNTIME_COMMAND.assertNotVisible:
      return await invokeMaestroAssertNotVisible(params);
    case MAESTRO_RUNTIME_COMMAND.pressEnter:
      return await invokeMaestroPressEnter(params);
    case MAESTRO_RUNTIME_COMMAND.waitForAnimationToEnd:
      return await invokeMaestroWaitForAnimationToEnd(params);
    case MAESTRO_RUNTIME_COMMAND.scrollUntilVisible:
      return await invokeMaestroScrollUntilVisible(params);
    case MAESTRO_RUNTIME_COMMAND.swipeScreen:
      return await invokeMaestroSwipeScreen(params);
    case MAESTRO_RUNTIME_COMMAND.swipeOn:
      return await invokeMaestroSwipeOn(params);
    case MAESTRO_RUNTIME_COMMAND.tapOn:
      return await invokeMaestroTapOn(params);
    case MAESTRO_RUNTIME_COMMAND.tapPointPercent:
      return await invokeMaestroTapPointPercent(params);
    case MAESTRO_RUNTIME_COMMAND.runScript:
      return invokeMaestroRunScript(params);
    default:
      return undefined;
  }
}

async function invokeMaestroPressEnter(params: {
  baseReq: ReplayBaseRequest;
  invoke: MaestroRuntimeInvoke;
}): Promise<DaemonResponse> {
  const keyboardResponse = await params.invoke({
    ...params.baseReq,
    command: 'keyboard',
    positionals: ['enter'],
  });
  if (keyboardResponse.ok) return keyboardResponse;

  return await params.invoke({
    ...params.baseReq,
    command: 'type',
    positionals: ['\n'],
  });
}

function invokeMaestroRunScript(params: {
  baseReq: ReplayBaseRequest;
  positionals: string[];
  scope: ReplayVarScope;
}): DaemonResponse {
  const [scriptPath] = params.positionals;
  if (!scriptPath) {
    return errorResponse('INVALID_ARGS', 'runScript requires a file path.');
  }
  try {
    const outputEnv = executeRunScriptFile({
      scriptPath,
      env: {
        ...params.scope.values,
        ...(params.baseReq.flags?.maestro?.runScriptEnv ?? {}),
      },
    });
    return { ok: true, data: { outputEnv } };
  } catch (error) {
    const appError = asAppError(error);
    return errorResponse(appError.code, appError.message, appError.details);
  }
}
