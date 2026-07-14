import { AppError } from '../../kernel/errors.ts';
import { pointInsideRect } from '../../utils/rect-center.ts';
import { MAESTRO_COMPATIBILITY_PRESETS } from './compatibility-policy.ts';
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
type MaestroTextCommand = MaestroCommandOf<'inputText' | 'eraseText' | 'pasteText'>;
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
  pasteText: executeTextCommand,
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
  return {
    appId: command.appId ?? request.appId,
    ...(command.stopApp === undefined ? {} : { stopApp: command.stopApp }),
    ...(command.clearState === undefined ? {} : { clearState: command.clearState }),
    ...(command.arguments === undefined ? {} : { arguments: command.arguments }),
    ...(command.launchArguments === undefined ? {} : { launchArguments: command.launchArguments }),
  };
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
          timeoutMs: MAESTRO_COMPATIBILITY_PRESETS.command.targetLookupTimeoutMs,
        },
        request,
        operations,
      );
      return await invokeOperation(
        operations.doubleTapOn,
        { target, ...(command.delay === undefined ? {} : { delay: command.delay }) },
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
          timeoutMs: MAESTRO_COMPATIBILITY_PRESETS.command.targetLookupTimeoutMs,
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
  if (!target) return {};
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
): Promise<MaestroInputTarget | undefined> {
  const query = {
    purpose: 'tap' as const,
    timeoutMs:
      command.optional === true
        ? MAESTRO_COMPATIBILITY_PRESETS.command.optionalTargetLookupTimeoutMs
        : MAESTRO_COMPATIBILITY_PRESETS.command.targetLookupTimeoutMs,
    index: command.index,
    childOf: command.childOf,
    allowAtomicSelectorDispatch: command.repeat === undefined && command.delay === undefined,
  };
  return command.optional === true
    ? await resolveInputTarget(command.target, query, request, operations, true)
    : await resolveInputTarget(command.target, query, request, operations);
}

function tapOnInput(command: MaestroCommandOf<'tapOn'>, target: MaestroInputTarget) {
  return {
    target,
    ...(command.repeat === undefined ? {} : { repeat: command.repeat }),
    ...(command.delay === undefined ? {} : { delay: command.delay }),
    ...(command.optional === undefined ? {} : { optional: command.optional }),
    ...(command.label === undefined ? {} : { label: command.label }),
    ...(command.index === undefined ? {} : { index: command.index }),
    ...(command.childOf === undefined ? {} : { childOf: command.childOf }),
  };
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
      authoredSwipe: swipe.authored,
      ...(swipe.target ? { swipeTarget: swipe.target } : {}),
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
        { text: command.text, ...(command.label === undefined ? {} : { label: command.label }) },
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
    case 'pasteText':
      return await invokeOperation(
        operations.pasteText,
        { text: command.text },
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
  };
}

function waitForAnimationToEndInput(command: MaestroCommandOf<'waitForAnimationToEnd'>) {
  return { ...(command.timeout === undefined ? {} : { timeoutMs: command.timeout }) };
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
        {
          file: command.file,
          ...(command.env === undefined ? {} : { env: command.env }),
        },
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
  if (observationEffect === 'invalidate') context.invalidateObservation();
  const result = await operation(input, context);
  return resultWithArtifacts(
    result,
    [],
    observationEffect === 'preserve' ? observation : undefined,
    context.generation,
    observationEffect === 'preserve',
  );
}

function resultWithArtifacts(
  result: MaestroRuntimeOperationResult | void,
  defaultArtifacts: readonly string[],
  observation?: MaestroObservation,
  generation?: number,
  includeOperationObservation = true,
): MaestroRuntimeResult {
  const operationObservation = result?.observation;
  assertObservationGeneration(operationObservation, generation);
  return {
    ...optionalObservation(
      observation ?? (includeOperationObservation ? operationObservation : undefined),
    ),
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

function resolveInputTarget(
  authored: MaestroGestureTarget,
  query: Pick<MaestroTargetQuery, 'purpose' | 'timeoutMs' | 'index' | 'childOf'>,
  request: MaestroRuntimeRequest,
  operations: MaestroRuntimeOperations,
  optional: true,
): Promise<MaestroInputTarget | undefined>;
function resolveInputTarget(
  authored: MaestroGestureTarget,
  query: Pick<MaestroTargetQuery, 'purpose' | 'timeoutMs' | 'index' | 'childOf'>,
  request: MaestroRuntimeRequest,
  operations: MaestroRuntimeOperations,
  optional?: false,
): Promise<MaestroInputTarget>;
async function resolveInputTarget(
  authored: MaestroGestureTarget,
  query: Pick<MaestroTargetQuery, 'purpose' | 'timeoutMs' | 'index' | 'childOf'>,
  request: MaestroRuntimeRequest,
  operations: MaestroRuntimeOperations,
  optional = false,
): Promise<MaestroInputTarget | undefined> {
  if (authored.space === 'target') {
    const resolution = optional
      ? await resolveMaestroTarget(authored.selector, query, request, operations, true)
      : await resolveMaestroTarget(authored.selector, query, request, operations);
    if (!resolution) return undefined;
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
