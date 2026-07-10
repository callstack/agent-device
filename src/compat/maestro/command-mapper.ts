import type { SessionAction } from '../../daemon/types.ts';
import { AppError } from '../../kernel/errors.ts';
import { convertLaunchApp, convertStopApp } from './device-actions.ts';
import {
  convertDoubleTapOn,
  convertEraseText,
  convertExtendedWaitUntil,
  convertLongPressOn,
  convertPressKey,
  convertScroll,
  convertScrollUntilVisible,
  convertSwipe,
  convertTapOn,
  maestroSelector,
  readInputText,
} from './interactions.ts';
import {
  action,
  assertOnlyKeys,
  isPlainRecord,
  readTimeoutMs,
  requireAppId,
  requireStringValue,
  resolveMaestroString,
  unsupportedCommand,
} from './support.ts';
import { convertRepeat, convertRetry, convertRunFlow } from './flow-control.ts';
import { convertRunScript } from './run-script.ts';
import { MAESTRO_RUNTIME_COMMAND } from './runtime-commands.ts';
import type {
  MaestroCommand,
  MaestroCommandMapperDeps,
  MaestroConvertedActions,
  MaestroFlowConfig,
  MaestroParseContext,
} from './types.ts';

// Handlers that cannot produce foreign-file actions return bare actions;
// toConvertedActions normalizes them to the pipeline's uniform shape.
type MaestroCommandHandler = (params: {
  value: unknown;
  config: MaestroFlowConfig;
  context: MaestroParseContext;
  deps: MaestroCommandMapperDeps;
  name: string;
}) => SessionAction[] | MaestroConvertedActions;

function toConvertedActions(
  result: SessionAction[] | MaestroConvertedActions,
): MaestroConvertedActions {
  if (Array.isArray(result)) {
    return { actions: result, sources: result.map(() => undefined) };
  }
  return result;
}

const MAP_COMMAND_HANDLERS: Record<string, MaestroCommandHandler> = {
  launchApp: ({ value, config, context }) => [convertLaunchApp(value, config, context)],
  tapOn: ({ value, context }) => [convertTapOn(value, context)],
  doubleTapOn: ({ value, context }) => [convertDoubleTapOn(value, context)],
  longPressOn: ({ value, context }) => [convertLongPressOn(value, context)],
  inputText: ({ value, context }) => [
    action('type', [resolveMaestroString(readInputText(value), context)]),
  ],
  eraseText: ({ value }) => [convertEraseText(value)],
  pasteText: ({ value, context, name }) => [
    action('type', [resolveMaestroString(requireStringValue(name, value), context)]),
  ],
  openLink: ({ value, config, context, name }) => [convertOpenLink(value, config, context, name)],
  assertVisible: ({ value, context, name }) => [
    action(MAESTRO_RUNTIME_COMMAND.assertVisible, [
      maestroSelector(value, name, [], context),
      '17000',
    ]),
  ],
  assertNotVisible: ({ value, context, name }) => [
    action(MAESTRO_RUNTIME_COMMAND.assertNotVisible, [maestroSelector(value, name, [], context)]),
  ],
  extendedWaitUntil: ({ value, context }) => convertExtendedWaitUntil(value, context),
  takeScreenshot: ({ value, context, name }) => [
    action('screenshot', [resolveMaestroString(requireStringValue(name, value), context)]),
  ],
  scroll: ({ value }) => [convertScroll(value)],
  scrollUntilVisible: ({ value, context }) => convertScrollUntilVisible(value, context),
  swipe: ({ value, context }) => [convertSwipe(value, context)],
  hideKeyboard: () => [action('keyboard', ['dismiss'])],
  pressKey: ({ value }) => [convertPressKey(value)],
  back: () => [action('back')],
  waitForAnimationToEnd: ({ value }) => [
    action(MAESTRO_RUNTIME_COMMAND.waitForAnimationToEnd, [String(readTimeoutMs(value, 15000))]),
  ],
  stopApp: ({ value, config, context }) => [convertStopApp(value, config, context)],
  runScript: ({ value, context }) => [convertRunScript(value, context)],
  runFlow: ({ value, config, context, deps }) =>
    convertRunFlow(value, config, context, deps, convertCommandList),
  repeat: ({ value, config, context, deps }) =>
    convertRepeat(value, config, context, deps, convertCommandList),
  retry: ({ value, config, context, deps }) =>
    convertRetry(value, config, context, deps, convertCommandList),
};

const SCALAR_COMMAND_HANDLERS: Record<
  string,
  (config: MaestroFlowConfig, context: MaestroParseContext) => SessionAction[]
> = {
  launchApp: (config, context) => [convertLaunchApp(undefined, config, context)],
  scroll: () => [action('scroll', ['down'])],
  hideKeyboard: () => [action('keyboard', ['dismiss'])],
  eraseText: () => [convertEraseText(undefined)],
  back: () => [action('back')],
  waitForAnimationToEnd: () => [action(MAESTRO_RUNTIME_COMMAND.waitForAnimationToEnd, ['15000'])],
  stopApp: (config, context) => [convertStopApp(undefined, config, context)],
};

export function convertMaestroCommandWithLine(
  command: MaestroCommand,
  config: MaestroFlowConfig,
  line: number,
  context: MaestroParseContext,
  deps: MaestroCommandMapperDeps,
): MaestroConvertedActions {
  try {
    return convertMaestroCommand(command, config, context, deps);
  } catch (error) {
    if (error instanceof AppError && !/\bline \d+\b/.test(error.message)) {
      throw new AppError(error.code, `${error.message} (line ${line})`, error.details);
    }
    throw error;
  }
}

function convertMaestroCommand(
  command: MaestroCommand,
  config: MaestroFlowConfig,
  context: MaestroParseContext,
  deps: MaestroCommandMapperDeps,
): MaestroConvertedActions {
  if (typeof command === 'string') {
    return toConvertedActions(convertScalarCommand(command, config, context));
  }

  const entries = Object.entries(command);
  if (entries.length !== 1) {
    throw new AppError('INVALID_ARGS', 'Maestro command maps must contain exactly one command.');
  }

  const [name, value] = entries[0] as [string, unknown];
  const handler = MAP_COMMAND_HANDLERS[name];
  if (!handler) return toConvertedActions(unsupportedCommand(name));
  return toConvertedActions(handler({ value, config, context, deps, name }));
}

function convertScalarCommand(
  command: string,
  config: MaestroFlowConfig,
  context: MaestroParseContext,
): SessionAction[] {
  const handler = SCALAR_COMMAND_HANDLERS[command];
  if (!handler) return unsupportedCommand(command);
  return handler(config, context);
}

function convertOpenLink(
  value: unknown,
  config: MaestroFlowConfig,
  context: MaestroParseContext,
  name: string,
): SessionAction {
  const rawLink = readOpenLink(value, name);
  const url = resolveMaestroString(rawLink, context);
  if ((context.platform === 'ios' || context.platform === 'android') && config.appId) {
    return action(
      'open',
      [resolveMaestroString(requireAppId(config, name), context), url],
      context.platform === 'ios' ? { maestro: { prewarmRunnerBeforeOpen: true } } : undefined,
    );
  }
  return action('open', [url]);
}

function readOpenLink(value: unknown, name: string): string {
  if (typeof value === 'string') return value;
  if (!isPlainRecord(value)) return requireStringValue(name, value);
  assertOnlyKeys(value, name, ['link']);
  return requireStringValue(`${name}.link`, value.link);
}

function convertCommandList(
  commands: MaestroCommand[],
  config: MaestroFlowConfig,
  context: MaestroParseContext,
  deps: MaestroCommandMapperDeps,
): MaestroConvertedActions {
  const converted = commands.map((command, index) =>
    convertMaestroCommandWithLine(command, config, index + 1, context, deps),
  );
  return {
    actions: converted.flatMap((entry) => entry.actions),
    sources: converted.flatMap((entry) => entry.sources),
  };
}
