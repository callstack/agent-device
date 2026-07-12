import { AppError } from '../../kernel/errors.ts';
import { pointInsideRect } from '../../utils/rect-center.ts';
import type { MaestroGestureTarget } from './program-ir.ts';
import type {
  MaestroObservation,
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

const DEFAULT_SCROLL_UNTIL_VISIBLE_TIMEOUT_MS = 5_000;
const MAESTRO_INPUT_TARGET_TIMEOUT_MS = 30_000;
const MAESTRO_OPTIONAL_INPUT_TARGET_TIMEOUT_MS = 3_000;

export async function executeMaestroRuntimeCommand(
  request: MaestroRuntimeRequest,
  operations: MaestroRuntimeOperations,
): Promise<MaestroRuntimeResult> {
  const command = request.command;
  const context = operationContext(request, command);

  switch (command.kind) {
    case 'launchApp':
      return await invokeMutation(
        operations.launchApp,
        {
          appId: command.appId ?? request.appId,
          ...(command.stopApp === undefined ? {} : { stopApp: command.stopApp }),
          ...(command.clearState === undefined ? {} : { clearState: command.clearState }),
          ...(command.arguments === undefined ? {} : { arguments: command.arguments }),
          ...(command.launchArguments === undefined
            ? {}
            : { launchArguments: command.launchArguments }),
        },
        context,
        true,
      );
    case 'stopApp':
      return await invokeMutation(
        operations.stopApp,
        { appId: command.appId ?? request.appId },
        context,
        true,
      );
    case 'openLink':
      return await invokeMutation(operations.openLink, { link: command.link }, context, true);
    case 'tapOn': {
      const query = {
        purpose: 'tap' as const,
        timeoutMs:
          command.optional === true
            ? MAESTRO_OPTIONAL_INPUT_TARGET_TIMEOUT_MS
            : MAESTRO_INPUT_TARGET_TIMEOUT_MS,
        index: command.index,
        childOf: command.childOf,
      };
      const target =
        command.optional === true
          ? await resolveInputTarget(command.target, query, request, operations, true)
          : await resolveInputTarget(command.target, query, request, operations);
      if (!target) return { mutated: false };
      return await invokeMutation(
        operations.tapOn,
        {
          target,
          ...(command.repeat === undefined ? {} : { repeat: command.repeat }),
          ...(command.delay === undefined ? {} : { delay: command.delay }),
          ...(command.optional === undefined ? {} : { optional: command.optional }),
          ...(command.label === undefined ? {} : { label: command.label }),
          ...(command.index === undefined ? {} : { index: command.index }),
          ...(command.childOf === undefined ? {} : { childOf: command.childOf }),
        },
        context,
        true,
        target.resolution ? observationForTarget(target.resolution) : undefined,
      );
    }
    case 'doubleTapOn': {
      const target = await resolveInputTarget(
        command.target,
        { purpose: 'doubleTap', timeoutMs: MAESTRO_INPUT_TARGET_TIMEOUT_MS },
        request,
        operations,
      );
      return await invokeMutation(
        operations.doubleTapOn,
        { target, ...(command.delay === undefined ? {} : { delay: command.delay }) },
        context,
        true,
        target.resolution ? observationForTarget(target.resolution) : undefined,
      );
    }
    case 'longPressOn': {
      const target = await resolveInputTarget(
        command.target,
        { purpose: 'longPress', timeoutMs: MAESTRO_INPUT_TARGET_TIMEOUT_MS },
        request,
        operations,
      );
      return await invokeMutation(
        operations.longPressOn,
        { target },
        context,
        true,
        target.resolution ? observationForTarget(target.resolution) : undefined,
      );
    }
    case 'swipe': {
      const swipe = await resolveMaestroSwipeOperation(command.gesture, request, operations);
      return await invokeMutation(
        operations.gesture,
        swipe.gesture,
        {
          ...context,
          authoredSwipe: swipe.authored,
          ...(swipe.target ? { swipeTarget: swipe.target } : {}),
          ...(swipe.viewport ? { gestureViewport: swipe.viewport } : {}),
        },
        true,
        swipe.target ? observationForTarget(swipe.target) : undefined,
      );
    }
    case 'inputText':
      return await invokeMutation(
        operations.inputText,
        { text: command.text, ...(command.label === undefined ? {} : { label: command.label }) },
        context,
        true,
      );
    case 'eraseText':
      return await invokeMutation(
        operations.eraseText,
        {
          ...(command.charactersToErase === undefined
            ? {}
            : { charactersToErase: command.charactersToErase }),
        },
        context,
        true,
      );
    case 'pasteText':
      return await invokeMutation(operations.pasteText, { text: command.text }, context, true);
    case 'scroll':
      return await invokeMutation(operations.scroll, { direction: 'down' }, context, true);
    case 'scrollUntilVisible':
      return await invokeMutation(
        operations.scrollUntilVisible,
        {
          selector: command.element,
          direction: command.direction ?? 'down',
          timeoutMs: command.timeout ?? DEFAULT_SCROLL_UNTIL_VISIBLE_TIMEOUT_MS,
        },
        context,
        true,
      );
    case 'hideKeyboard':
      return await invokeMutation(operations.hideKeyboard, {}, context, true);
    case 'pressKey':
      return await invokeMutation(operations.pressKey, { key: command.key }, context, true);
    case 'back':
      return await invokeMutation(operations.back, {}, context, true);
    case 'waitForAnimationToEnd':
      return await invokeMutation(
        operations.waitForAnimationToEnd,
        { ...(command.timeout === undefined ? {} : { timeoutMs: command.timeout }) },
        context,
        false,
      );
    case 'takeScreenshot': {
      const result = await operations.takeScreenshot({ path: command.path }, context);
      return resultWithArtifacts(false, result, [], undefined, context.generation);
    }
    case 'runScript':
      return await invokeMutation(
        operations.runScript,
        {
          file: command.file,
          ...(command.env === undefined ? {} : { env: command.env }),
        },
        context,
        false,
      );
    case 'assertVisible':
    case 'assertNotVisible':
    case 'extendedWaitUntil':
      throw new AppError(
        'COMMAND_FAILED',
        `Maestro ${command.kind} must be executed by the observation engine.`,
      );
  }
}

async function invokeMutation<TInput>(
  operation: (
    input: TInput,
    context: MaestroRuntimeOperationContext,
  ) => Promise<MaestroRuntimeOperationResult | void>,
  input: TInput,
  context: MaestroRuntimeOperationContext,
  mutated: boolean,
  observation?: MaestroObservation,
): Promise<MaestroRuntimeResult> {
  const result = await operation(input, context);
  return resultWithArtifacts(mutated, result, [], observation, context.generation);
}

function resultWithArtifacts(
  mutated: boolean,
  result: MaestroRuntimeOperationResult | void,
  defaultArtifacts: readonly string[],
  observation?: MaestroObservation,
  generation?: number,
): MaestroRuntimeResult {
  const operationObservation = result?.observation;
  if (
    operationObservation &&
    generation !== undefined &&
    operationObservation.generation !== generation
  ) {
    throw new AppError(
      'COMMAND_FAILED',
      `Maestro operation evidence generation ${operationObservation.generation} does not match ${generation}.`,
    );
  }
  const artifactPaths = [...new Set([...defaultArtifacts, ...(result?.artifactPaths ?? [])])];
  return {
    mutated,
    ...((observation ?? result?.observation)
      ? { observation: observation ?? operationObservation }
      : {}),
    ...(result?.outputEnv ? { outputEnv: { ...result.outputEnv } } : {}),
    ...(artifactPaths.length > 0 ? { artifactPaths } : {}),
  };
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
