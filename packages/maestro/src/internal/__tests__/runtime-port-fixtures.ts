import type {
  MaestroRuntimeOperationContext,
  MaestroRuntimeOperations,
} from '../runtime-port-types.ts';
import { executeMaestroPlan } from '../engine.ts';
import type {
  MaestroEngineOptions,
  MaestroEngineResult,
  MaestroRuntimePort,
} from '../engine-types.ts';
import type { MaestroProgram } from '../program-ir.ts';
import { compileMaestroReplayPlan } from '../replay-plan.ts';
import { executeMaestroRuntimeCommand } from '../runtime-port-commands.ts';
import { observeMaestroCondition } from '../runtime-port-observation.ts';

export type RecordedCall = {
  kind: string;
  input: unknown;
  generation: number;
  appId?: string;
};

export async function executeMaestroProgram(
  program: MaestroProgram,
  port: MaestroRuntimePort,
  options: MaestroEngineOptions = {},
): Promise<MaestroEngineResult> {
  return await executeMaestroPlan(await compileMaestroReplayPlan(program, options), port, options);
}

export function createMaestroRuntimePort(operations: MaestroRuntimeOperations): MaestroRuntimePort {
  return {
    execute: async (request) => await executeMaestroRuntimeCommand(request, operations),
    observe: async (request) => await observeMaestroCondition(request, operations),
  };
}

export function makeOperations(
  overrides: Partial<MaestroRuntimeOperations> = {},
): MaestroRuntimeOperations {
  const noOp = async (): Promise<void> => undefined;
  return {
    platform: 'android',
    resolveTarget: async ({ selector }, context) => ({
      generation: context.generation,
      matched: true,
      visible: true,
      candidateCount: 1,
      rect: { x: 100, y: 200, width: 100, height: 80 },
      viewport: { x: 0, y: 0, width: 402, height: 874 },
      ref: selector.id ? 'e1' : undefined,
    }),
    observe: async (_input, context) => ({
      generation: context.generation,
      matched: true,
      visible: true,
      candidateCount: 1,
    }),
    resolveGestureViewport: async () => ({ x: 0, y: 0, width: 402, height: 874 }),
    launchApp: noOp,
    stopApp: noOp,
    openLink: noOp,
    tapOn: noOp,
    doubleTapOn: noOp,
    longPressOn: noOp,
    gesture: noOp,
    inputText: noOp,
    eraseText: noOp,
    scroll: noOp,
    scrollUntilVisible: noOp,
    pressKey: noOp,
    back: noOp,
    hideKeyboard: noOp,
    waitForAnimationToEnd: noOp,
    takeScreenshot: noOp,
    runScript: noOp,
    ...overrides,
  };
}

export function record(
  calls: RecordedCall[],
  kind: string,
  input: unknown,
  context: MaestroRuntimeOperationContext,
): void {
  calls.push({
    kind,
    input,
    generation: context.generation,
    ...(context.appId === undefined ? {} : { appId: context.appId }),
  });
}
