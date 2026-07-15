import { AppError } from '../../kernel/errors.ts';
import { pointInsideRect } from '../../utils/rect-center.ts';
import { stripUndefined } from '../../utils/parsing.ts';
import {
  maestroScrollDurationFromSpeed,
  MAESTRO_COMPATIBILITY_PRESETS,
} from './compatibility-policy.ts';
import type { MaestroGestureTarget } from './program-ir.ts';
import type {
  MaestroObservation,
  MaestroObservationEffect,
  MaestroRuntimeCommand,
  MaestroRuntimeRequest,
  MaestroRuntimeResult,
} from './engine-types.ts';
import { operationContext } from './runtime-port-context.ts';
import { observationForTarget, resolveMaestroTarget } from './runtime-port-observation.ts';
import { resolveMaestroCoordinate, resolveMaestroSwipeOperation } from './runtime-port-geometry.ts';
import type {
  MaestroInputTarget,
  MaestroRuntimeOperationContext,
  MaestroRuntimeOperationResult,
  MaestroRuntimeOperations,
  MaestroTargetQuery,
} from './runtime-port-types.ts';

type MaestroCommandOf<K extends MaestroRuntimeCommand['kind']> = Extract<
  MaestroRuntimeCommand,
  { kind: K }
>;

type MaestroLifecycleCommand = MaestroCommandOf<'launchApp' | 'stopApp' | 'openLink'>;
type MaestroTargetCommand = MaestroCommandOf<'tapOn' | 'doubleTapOn' | 'longPressOn'>;
type MaestroTextCommand = MaestroCommandOf<'inputText' | 'eraseText'>;
type MaestroNavigationCommand = MaestroCommandOf<
  'scroll' | 'scrollUntilVisible' | 'hideKeyboard' | 'pressKey' | 'back' | 'waitForAnimationToEnd'
>;
type MaestroSupportCommand = MaestroCommandOf<'takeScreenshot' | 'runScript'>;
type MaestroObservationCommand = MaestroCommandOf<
  'assertVisible' | 'assertNotVisible' | 'extendedWaitUntil'
>;
type MaestroCommandKind = MaestroRuntimeCommand['kind'];
type MaestroRuntimeCommandHandler<K extends MaestroCommandKind> = (
  command: MaestroCommandOf<K>,
  request: MaestroRuntimeRequest,
  operations: MaestroRuntimeOperations,
  context: MaestroRuntimeOperationContext,
) => Promise<MaestroRuntimeResult>;
type MaestroRuntimeCommandHandlers = {
  [K in MaestroCommandKind]: MaestroRuntimeCommandHandler<K>;
};

const MAESTRO_RUNTIME_COMMAND_HANDLERS = {
  launchApp: executeLifecycleCommand,
  stopApp: executeLifecycleCommand,
  openLink: executeLifecycleCommand,
  tapOn: executeTargetCommand,
  doubleTapOn: executeTargetCommand,
  longPressOn: executeTargetCommand,
  swipe: executeSwipeCommand,
  inputText: executeTextCommand,
  eraseText: executeTextCommand,
  scroll: executeNavigationCommand,
  scrollUntilVisible: executeNavigationCommand,
  hideKeyboard: executeNavigationCommand,
  pressKey: executeNavigationCommand,
  back: executeNavigationCommand,
  waitForAnimationToEnd: executeNavigationCommand,
  takeScreenshot: executeSupportCommand,
  runScript: executeSupportCommand,
  assertVisible: executeObservationCommand,
  assertNotVisible: executeObservationCommand,
  extendedWaitUntil: executeObservationCommand,
} satisfies MaestroRuntimeCommandHandlers;

const MAESTRO_COMMAND_REQUIRES_SETTLED_PREDECESSOR = {
  launchApp: true,
  stopApp: true,
  openLink: true,
  tapOn: true,
  doubleTapOn: true,
  longPressOn: true,
  swipe: true,
  inputText: true,
  eraseText: true,
  scroll: true,
  scrollUntilVisible: true,
  hideKeyboard: true,
  pressKey: true,
  back: true,
  waitForAnimationToEnd: false,
  takeScreenshot: false,
  runScript: false,
  assertVisible: false,
  assertNotVisible: false,
  extendedWaitUntil: false,
} satisfies Record<MaestroCommandKind, boolean>;

export function maestroCommandRequiresSettledPredecessor(command: MaestroRuntimeCommand): boolean {
  return MAESTRO_COMMAND_REQUIRES_SETTLED_PREDECESSOR[command.kind];
}

export async function executeMaestroRuntimeCommand(
  request: MaestroRuntimeRequest,
  operations: MaestroRuntimeOperations,
): Promise<MaestroRuntimeResult> {
  const command = request.command;
  const context = operationContext(request, command);
  return await dispatchMaestroRuntimeCommand(command, request, operations, context);
}

function dispatchMaestroRuntimeCommand<K extends MaestroCommandKind>(
  command: MaestroCommandOf<K>,
  request: MaestroRuntimeRequest,
  operations: MaestroRuntimeOperations,
  context: MaestroRuntimeOperationContext,
): Promise<MaestroRuntimeResult> {
  const handler = MAESTRO_RUNTIME_COMMAND_HANDLERS[command.kind] as MaestroRuntimeCommandHandler<K>;
  return handler(command, request, operations, context);
}

async function executeLifecycleCommand(
  command: MaestroLifecycleCommand,
  request: MaestroRuntimeRequest,
  operations: MaestroRuntimeOperations,
  context: MaestroRuntimeOperationContext,
): Promise<MaestroRuntimeResult> {
  switch (command.kind) {
    case 'launchApp':
      return await invokeOperation(
        operations.launchApp,
        launchAppInput(command, request),
        context,
        'invalidate',
      );
    case 'stopApp':
      return await invokeOperation(
        operations.stopApp,
        { appId: command.appId ?? request.appId },
        context,
        'invalidate',
      );
    case 'openLink':
      return await invokeOperation(
        operations.openLink,
        { link: command.link },
        context,
        'invalidate',
      );
  }
}

function launchAppInput(command: MaestroCommandOf<'launchApp'>, request: MaestroRuntimeRequest) {
  return stripUndefined({
    appId: command.appId ?? request.appId,
    stopApp: command.stopApp,
    clearState: command.clearState,
    arguments: command.arguments,
    launchArguments: command.launchArguments,
  });
}

async function executeTargetCommand(
  command: MaestroTargetCommand,
  request: MaestroRuntimeRequest,
  operations: MaestroRuntimeOperations,
  context: MaestroRuntimeOperationContext,
): Promise<MaestroRuntimeResult> {
  switch (command.kind) {
    case 'tapOn':
      return await executeTapOnCommand(command, request, operations, context);
    case 'doubleTapOn': {
      const target = await resolveInputTarget(
        command.target,
        {
          purpose: 'doubleTap',
          timeoutMs: targetLookupTimeout(command),
        },
        request,
        operations,
      );
      return await invokeOperation(
        operations.doubleTapOn,
        {
          target,
          delay: command.delay ?? MAESTRO_COMPATIBILITY_PRESETS.command.repeatDelayMs,
        },
        context,
        'invalidate',
        target.resolution ? observationForTarget(target.resolution) : undefined,
      );
    }
    case 'longPressOn': {
      const target = await resolveInputTarget(
        command.target,
        {
          purpose: 'longPress',
          timeoutMs: targetLookupTimeout(command),
        },
        request,
        operations,
      );
      return await invokeOperation(
        operations.longPressOn,
        { target },
        context,
        'invalidate',
        target.resolution ? observationForTarget(target.resolution) : undefined,
      );
    }
  }
}

async function executeTapOnCommand(
  command: MaestroCommandOf<'tapOn'>,
  request: MaestroRuntimeRequest,
  operations: MaestroRuntimeOperations,
  context: MaestroRuntimeOperationContext,
): Promise<MaestroRuntimeResult> {
  const target = await resolveTapOnTarget(command, request, operations);
  return await invokeOperation(
    operations.tapOn,
    tapOnInput(command, target),
    context,
    'invalidate',
    target.resolution ? observationForTarget(target.resolution) : undefined,
  );
}

async function resolveTapOnTarget(
  command: MaestroCommandOf<'tapOn'>,
  request: MaestroRuntimeRequest,
  operations: MaestroRuntimeOperations,
): Promise<MaestroInputTarget> {
  const query = {
    purpose: 'tap' as const,
    timeoutMs: targetLookupTimeout(command),
    index: command.index,
    childOf: command.childOf,
    allowAtomicSelectorDispatch: command.repeat === undefined && command.delay === undefined,
    ...(command.retryTapIfNoChange === true ? { includeSurfaceSignature: true } : {}),
  };
  return await resolveInputTarget(command.target, query, request, operations);
}

function targetLookupTimeout(command: { readonly optional?: boolean }): number {
  return command.optional === true
    ? MAESTRO_COMPATIBILITY_PRESETS.command.optionalTargetLookupTimeoutMs
    : MAESTRO_COMPATIBILITY_PRESETS.command.targetLookupTimeoutMs;
}

function tapOnInput(command: MaestroCommandOf<'tapOn'>, target: MaestroInputTarget) {
  const delay =
    command.repeat === undefined
      ? command.delay
      : (command.delay ?? MAESTRO_COMPATIBILITY_PRESETS.command.repeatDelayMs);
  return stripUndefined({
    target,
    retryTapIfNoChange: command.retryTapIfNoChange,
    repeat: command.repeat,
    delay,
  });
}

async function executeSwipeCommand(
  command: MaestroCommandOf<'swipe'>,
  request: MaestroRuntimeRequest,
  operations: MaestroRuntimeOperations,
  context: MaestroRuntimeOperationContext,
): Promise<MaestroRuntimeResult> {
  const swipe = await resolveMaestroSwipeOperation(command.gesture, request, operations);
  return await invokeOperation(
    operations.gesture,
    swipe.gesture,
    {
      ...context,
      ...(swipe.viewport ? { gestureViewport: swipe.viewport } : {}),
    },
    'invalidate',
    swipe.target ? observationForTarget(swipe.target) : undefined,
  );
}

async function executeTextCommand(
  command: MaestroTextCommand,
  _request: MaestroRuntimeRequest,
  operations: MaestroRuntimeOperations,
  context: MaestroRuntimeOperationContext,
): Promise<MaestroRuntimeResult> {
  switch (command.kind) {
    case 'inputText':
      return await invokeOperation(
        operations.inputText,
        stripUndefined({ text: command.text, label: command.label }),
        context,
        'invalidate',
      );
    case 'eraseText':
      return await invokeOperation(
        operations.eraseText,
        {
          ...(command.charactersToErase === undefined
            ? {}
            : { charactersToErase: command.charactersToErase }),
        },
        context,
        'invalidate',
      );
  }
}

async function executeNavigationCommand(
  command: MaestroNavigationCommand,
  _request: MaestroRuntimeRequest,
  operations: MaestroRuntimeOperations,
  context: MaestroRuntimeOperationContext,
): Promise<MaestroRuntimeResult> {
  switch (command.kind) {
    case 'scroll':
      return await invokeOperation(operations.scroll, { direction: 'down' }, context, 'invalidate');
    case 'scrollUntilVisible':
      return await invokeOperation(
        operations.scrollUntilVisible,
        scrollUntilVisibleInput(command),
        context,
        'invalidate',
      );
    case 'hideKeyboard':
      return await invokeOperation(operations.hideKeyboard, {}, context, 'invalidate');
    case 'pressKey':
      return await invokeOperation(
        operations.pressKey,
        { key: command.key },
        context,
        'invalidate',
      );
    case 'back':
      return await invokeOperation(operations.back, {}, context, 'invalidate');
    case 'waitForAnimationToEnd':
      return await invokeOperation(
        operations.waitForAnimationToEnd,
        waitForAnimationToEndInput(command),
        context,
        'invalidate',
      );
  }
}

function scrollUntilVisibleInput(command: MaestroCommandOf<'scrollUntilVisible'>) {
  return {
    selector: command.element,
    direction: command.direction ?? 'down',
    timeoutMs: command.timeout ?? MAESTRO_COMPATIBILITY_PRESETS.command.scrollUntilVisibleTimeoutMs,
    durationMs: maestroScrollDurationFromSpeed(
      MAESTRO_COMPATIBILITY_PRESETS.command.scrollUntilVisibleSpeed,
    ),
  };
}

function waitForAnimationToEndInput(command: MaestroCommandOf<'waitForAnimationToEnd'>) {
  return stripUndefined({ timeoutMs: command.timeout });
}

async function executeSupportCommand(
  command: MaestroSupportCommand,
  _request: MaestroRuntimeRequest,
  operations: MaestroRuntimeOperations,
  context: MaestroRuntimeOperationContext,
): Promise<MaestroRuntimeResult> {
  switch (command.kind) {
    case 'takeScreenshot': {
      const result = await operations.takeScreenshot({ path: command.path }, context);
      return resultWithArtifacts(result, [], undefined, context.generation);
    }
    case 'runScript':
      return await invokeOperation(
        operations.runScript,
        stripUndefined({ file: command.file, env: command.env }),
        context,
        'preserve',
      );
  }
}

async function executeObservationCommand(command: MaestroObservationCommand): Promise<never> {
  throw new AppError(
    'COMMAND_FAILED',
    `Maestro ${command.kind} must be executed by the observation engine.`,
  );
}

async function invokeOperation<TInput>(
  operation: (
    input: TInput,
    context: MaestroRuntimeOperationContext,
  ) => Promise<MaestroRuntimeOperationResult | void>,
  input: TInput,
  context: MaestroRuntimeOperationContext,
  observationEffect: MaestroObservationEffect,
  observation?: MaestroObservation,
): Promise<MaestroRuntimeResult> {
  const operationContext = contextAfterObservationEffect(context, observationEffect);
  const result = await operation(input, operationContext);
  return resultWithArtifacts(
    result,
    [],
    observationEffect === 'preserve' ? observation : undefined,
    operationContext.generation,
  );
}

function contextAfterObservationEffect(
  context: MaestroRuntimeOperationContext,
  observationEffect: MaestroObservationEffect,
): MaestroRuntimeOperationContext {
  if (observationEffect === 'preserve') return context;
  context.invalidateObservation();
  return { ...context, generation: context.generation + 1 };
}

function resultWithArtifacts(
  result: MaestroRuntimeOperationResult | void,
  defaultArtifacts: readonly string[],
  observation?: MaestroObservation,
  generation?: number,
): MaestroRuntimeResult {
  const operationObservation = result?.observation;
  assertObservationGeneration(operationObservation, generation);
  return {
    ...optionalObservation(observation ?? operationObservation),
    ...optionalOutputEnv(result?.outputEnv),
    ...optionalArtifactPaths(defaultArtifacts, result?.artifactPaths),
  };
}

function assertObservationGeneration(
  observation: MaestroObservation | undefined,
  generation: number | undefined,
): void {
  if (!observation || generation === undefined || observation.generation === generation) return;
  throw new AppError(
    'COMMAND_FAILED',
    `Maestro operation evidence generation ${observation.generation} does not match ${generation}.`,
  );
}

function optionalObservation(
  observation: MaestroObservation | undefined,
): Partial<Pick<MaestroRuntimeResult, 'observation'>> {
  return observation ? { observation } : {};
}

function optionalOutputEnv(
  outputEnv: Record<string, string> | undefined,
): Partial<Pick<MaestroRuntimeResult, 'outputEnv'>> {
  return outputEnv ? { outputEnv: { ...outputEnv } } : {};
}

function optionalArtifactPaths(
  defaultArtifacts: readonly string[],
  operationArtifacts: readonly string[] | undefined,
): Partial<Pick<MaestroRuntimeResult, 'artifactPaths'>> {
  const artifactPaths = [...new Set([...defaultArtifacts, ...(operationArtifacts ?? [])])];
  return artifactPaths.length > 0 ? { artifactPaths } : {};
}

async function resolveInputTarget(
  authored: MaestroGestureTarget,
  query: Pick<MaestroTargetQuery, 'purpose' | 'timeoutMs' | 'index' | 'childOf'>,
  request: MaestroRuntimeRequest,
  operations: MaestroRuntimeOperations,
): Promise<MaestroInputTarget> {
  if (authored.space === 'target') {
    const resolution = await resolveMaestroTarget(authored.selector, query, request, operations);
    return {
      authored,
      point: pointInsideRect(resolution.rect),
      resolution,
    };
  }
  return {
    authored,
    point: await resolveMaestroCoordinate(authored, request, operations),
  };
}
