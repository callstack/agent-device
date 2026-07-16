import { isMap, isScalar, isSeq, type Node } from 'yaml';
import { stripUndefined } from '../../utils/parsing.ts';
import type {
  MaestroAssertNotVisibleCommand,
  MaestroAssertVisibleCommand,
  MaestroBackCommand,
  MaestroCommand,
  MaestroEraseTextCommand,
  MaestroExtendedWaitUntilCommand,
  MaestroHideKeyboardCommand,
  MaestroInputTextCommand,
  MaestroLaunchAppCommand,
  MaestroLaunchArguments,
  MaestroOpenLinkCommand,
  MaestroPressKeyCommand,
  MaestroScrollCommand,
  MaestroScrollUntilVisibleCommand,
  MaestroStopAppCommand,
  MaestroTakeScreenshotCommand,
  MaestroWaitForAnimationToEndCommand,
} from './program-ir.ts';
import {
  parseMaestroDirection,
  parseMaestroDoubleTapOnCommand,
  parseMaestroLongPressOnCommand,
  parseMaestroSelector,
  parseMaestroSelectorMapEntries,
  parseMaestroSwipeCommand,
  parseMaestroTapOnCommand,
} from './program-ir-gesture-parser.ts';
import {
  parseMaestroRepeatCommand,
  parseMaestroRetryCommand,
  parseMaestroRunFlowCommand,
  parseMaestroRunScriptCommand,
} from './program-ir-flow-parser.ts';
import {
  assertOnlyKeys,
  entryValue,
  hasEntry,
  invalidAt,
  isNullNode,
  readMapEntries,
  readOptionalBoolean,
  readOptionalCommandOption,
  readOptionalEntry,
  readOptionalNonNegativeInteger,
  readOptionalNumber,
  readOptionalString,
  readRequiredPositiveInteger,
  readRequiredString,
  readScalarMap,
  readScalarValue,
  readSequenceItems,
  sourceAt,
  type MaestroProgramParseContext,
} from './program-ir-values.ts';

export function parseMaestroCommandList(
  node: Node | null | undefined,
  name: string,
  context: MaestroProgramParseContext,
): MaestroCommand[] {
  return readSequenceItems(node, name, context).map((item) => parseMaestroCommand(item, context));
}

function parseMaestroCommand(
  node: Node | null | undefined,
  context: MaestroProgramParseContext,
): MaestroCommand {
  if (isScalar(node)) {
    if (typeof node.value !== 'string')
      invalidAt('Maestro command names must be strings.', node, context);
    return parseScalarCommand(node.value, node, context);
  }
  if (!isMap(node)) invalidAt('Maestro commands must be a scalar or one-key map.', node, context);
  const entries = readMapEntries(node, 'command', context);
  if (entries.length !== 1)
    invalidAt('Maestro command maps must contain exactly one command.', node, context);
  const entry = entries[0]!;
  return parseCommandValue(entry.key, entry.value, node, context);
}

function parseScalarCommand(
  name: string,
  node: Node,
  context: MaestroProgramParseContext,
): MaestroCommand {
  return parseCommandValue(name, null, node, context);
}

type CommandValueParser = (
  value: Node | null,
  commandNode: Node,
  context: MaestroProgramParseContext,
) => MaestroCommand;

const COMMAND_VALUE_PARSERS: Readonly<Record<string, CommandValueParser>> = {
  launchApp: parseLaunchApp,
  tapOn: parseMaestroTapOnCommand,
  doubleTapOn: parseMaestroDoubleTapOnCommand,
  longPressOn: parseMaestroLongPressOnCommand,
  inputText: parseInputText,
  eraseText: parseEraseText,
  openLink: parseOpenLink,
  assertVisible: (value, node, context) => parseAssertion('assertVisible', value, node, context),
  assertNotVisible: (value, node, context) =>
    parseAssertion('assertNotVisible', value, node, context),
  extendedWaitUntil: parseExtendedWaitUntil,
  takeScreenshot: parseTakeScreenshot,
  scroll: parseScroll,
  scrollUntilVisible: parseScrollUntilVisible,
  swipe: parseMaestroSwipeCommand,
  hideKeyboard: parseHideKeyboard,
  pressKey: parsePressKey,
  back: parseBack,
  waitForAnimationToEnd: parseWaitForAnimationToEnd,
  stopApp: parseStopApp,
  runScript: parseMaestroRunScriptCommand,
  runFlow: (value, node, context) =>
    parseMaestroRunFlowCommand(value, node, context, parseMaestroCommandList),
  repeat: (value, node, context) =>
    parseMaestroRepeatCommand(value, node, context, parseMaestroCommandList),
  retry: (value, node, context) =>
    parseMaestroRetryCommand(value, node, context, parseMaestroCommandList),
};

/**
 * The exact set of Maestro command names our engine accepts. This is the
 * authoritative supported surface — any name outside it is rejected by
 * `parseCommandValue`. The conformance oracle
 * (`scripts/maestro-conformance/verify.ts`) asserts every entry is either
 * corpus-covered or explicitly listed as unverified.
 */
export const SUPPORTED_MAESTRO_COMMAND_NAMES: readonly string[] =
  Object.keys(COMMAND_VALUE_PARSERS);

function parseCommandValue(
  name: string,
  value: Node | null,
  commandNode: Node,
  context: MaestroProgramParseContext,
): MaestroCommand {
  const parser = COMMAND_VALUE_PARSERS[name];
  if (!parser) invalidAt(`Maestro command "${name}" is not supported.`, commandNode, context);
  return parser(value, commandNode, context);
}

function parseLaunchApp(
  value: Node | null,
  commandNode: Node,
  context: MaestroProgramParseContext,
): MaestroLaunchAppCommand {
  const source = sourceAt(commandNode, context);
  if (isNullNode(value)) return { kind: 'launchApp', source };
  if (isScalar(value))
    return { kind: 'launchApp', source, appId: readRequiredString(value, 'launchApp', context) };
  const entries = readMapEntries(value, 'launchApp', context);
  assertOnlyKeys(
    entries,
    'launchApp',
    ['appId', 'stopApp', 'clearState', 'arguments', 'launchArguments'],
    context,
  );
  const appId = readOptionalEntry(entries, 'appId', (entry) =>
    readOptionalString(entry, 'launchApp.appId', context),
  );
  const stopApp = readOptionalEntry(entries, 'stopApp', (entry) =>
    readOptionalBoolean(entry, 'launchApp.stopApp', context),
  );
  const clearState = readOptionalEntry(entries, 'clearState', (entry) =>
    readOptionalBoolean(entry, 'launchApp.clearState', context),
  );
  const args = readOptionalEntry(entries, 'arguments', (entry) =>
    parseLaunchArguments(entry, 'launchApp.arguments', context),
  );
  const launchArguments = readOptionalEntry(entries, 'launchArguments', (entry) =>
    parseLaunchArguments(entry, 'launchApp.launchArguments', context),
  );
  return stripUndefined({
    kind: 'launchApp' as const,
    source,
    appId,
    stopApp,
    clearState,
    arguments: args,
    launchArguments,
  });
}

function parseInputText(
  value: Node | null,
  commandNode: Node,
  context: MaestroProgramParseContext,
): MaestroInputTextCommand {
  const source = sourceAt(commandNode, context);
  if (isScalar(value))
    return { kind: 'inputText', source, text: readRequiredString(value, 'inputText', context) };
  const entries = readMapEntries(value, 'inputText', context);
  assertOnlyKeys(entries, 'inputText', ['text', 'label'], context);
  if (!hasEntry(entries, 'text'))
    invalidAt('Maestro inputText requires text.', commandNode, context);
  const text = readRequiredString(entryValue(entries, 'text'), 'inputText.text', context);
  const label = hasEntry(entries, 'label')
    ? readOptionalString(entryValue(entries, 'label'), 'inputText.label', context)
    : undefined;
  return stripUndefined({ kind: 'inputText' as const, source, text, label });
}

function parseEraseText(
  value: Node | null,
  commandNode: Node,
  context: MaestroProgramParseContext,
): MaestroEraseTextCommand {
  const source = sourceAt(commandNode, context);
  if (isNullNode(value)) return { kind: 'eraseText', source };
  if (isScalar(value))
    return {
      kind: 'eraseText',
      source,
      charactersToErase: readRequiredPositiveInteger(value, 'eraseText', context),
    };
  const entries = readMapEntries(value, 'eraseText', context);
  assertOnlyKeys(entries, 'eraseText', ['charactersToErase'], context);
  const charactersToErase = hasEntry(entries, 'charactersToErase')
    ? readOptionalPositiveInteger(
        entryValue(entries, 'charactersToErase'),
        'eraseText.charactersToErase',
        context,
      )
    : undefined;
  return stripUndefined({
    kind: 'eraseText' as const,
    source,
    charactersToErase,
  });
}

function parseOpenLink(
  value: Node | null,
  commandNode: Node,
  context: MaestroProgramParseContext,
): MaestroOpenLinkCommand {
  const source = sourceAt(commandNode, context);
  if (isScalar(value))
    return { kind: 'openLink', source, link: readRequiredString(value, 'openLink', context) };
  const entries = readMapEntries(value, 'openLink', context);
  assertOnlyKeys(entries, 'openLink', ['link'], context);
  return {
    kind: 'openLink',
    source,
    link: readRequiredString(entryValue(entries, 'link'), 'openLink.link', context),
  };
}

function parseAssertion(
  kind: 'assertVisible' | 'assertNotVisible',
  value: Node | null,
  commandNode: Node,
  context: MaestroProgramParseContext,
): MaestroAssertVisibleCommand | MaestroAssertNotVisibleCommand {
  const source = sourceAt(commandNode, context);
  if (isScalar(value)) {
    return { kind, source, target: parseMaestroSelector(value, kind, context) };
  }
  const entries = readMapEntries(value, kind, context);
  assertOnlyKeys(entries, kind, ['id', 'text', 'enabled', 'selected', 'optional'], context);
  const options = readOptionalCommandOption(entries, kind, context);
  return {
    kind,
    source,
    target: parseMaestroSelectorMapEntries(
      entries.filter((entry) => entry.key !== 'optional'),
      kind,
      context,
    ),
    ...options,
  };
}

function parseExtendedWaitUntil(
  value: Node | null,
  commandNode: Node,
  context: MaestroProgramParseContext,
): MaestroExtendedWaitUntilCommand {
  const entries = readMapEntries(value, 'extendedWaitUntil', context);
  assertOnlyKeys(
    entries,
    'extendedWaitUntil',
    ['visible', 'notVisible', 'timeout', 'optional'],
    context,
  );
  const options = readOptionalCommandOption(entries, 'extendedWaitUntil', context);
  const visible = hasEntry(entries, 'visible')
    ? parseMaestroSelector(entryValue(entries, 'visible'), 'extendedWaitUntil.visible', context)
    : undefined;
  const notVisible = hasEntry(entries, 'notVisible')
    ? parseMaestroSelector(
        entryValue(entries, 'notVisible'),
        'extendedWaitUntil.notVisible',
        context,
      )
    : undefined;
  if (visible === undefined && notVisible === undefined)
    invalidAt('Maestro extendedWaitUntil requires visible or notVisible.', commandNode, context);
  const timeout = hasEntry(entries, 'timeout')
    ? readOptionalNumber(entryValue(entries, 'timeout'), 'extendedWaitUntil.timeout', context)
    : undefined;
  return stripUndefined({
    kind: 'extendedWaitUntil' as const,
    source: sourceAt(commandNode, context),
    visible,
    notVisible,
    timeout,
    ...options,
  });
}

function parseTakeScreenshot(
  value: Node | null,
  commandNode: Node,
  context: MaestroProgramParseContext,
): MaestroTakeScreenshotCommand {
  return {
    kind: 'takeScreenshot',
    source: sourceAt(commandNode, context),
    path: readRequiredString(value, 'takeScreenshot', context),
  };
}

function parseScroll(
  value: Node | null,
  commandNode: Node,
  context: MaestroProgramParseContext,
): MaestroScrollCommand {
  if (!isNullNode(value))
    invalidAt('Maestro scroll does not accept options yet.', commandNode, context);
  return { kind: 'scroll', source: sourceAt(commandNode, context) };
}

function parseScrollUntilVisible(
  value: Node | null,
  commandNode: Node,
  context: MaestroProgramParseContext,
): MaestroScrollUntilVisibleCommand {
  const source = sourceAt(commandNode, context);
  if (isScalar(value))
    return {
      kind: 'scrollUntilVisible',
      source,
      element: parseMaestroSelector(value, 'scrollUntilVisible.element', context),
    };
  const entries = readMapEntries(value, 'scrollUntilVisible', context);
  assertOnlyKeys(
    entries,
    'scrollUntilVisible',
    ['element', 'direction', 'timeout', 'optional'],
    context,
  );
  const options = readOptionalCommandOption(entries, 'scrollUntilVisible', context);
  if (!hasEntry(entries, 'element'))
    invalidAt('Maestro scrollUntilVisible requires element.', commandNode, context);
  const element = parseMaestroSelector(
    entryValue(entries, 'element'),
    'scrollUntilVisible.element',
    context,
  );
  const direction = hasEntry(entries, 'direction')
    ? parseMaestroDirection(
        entryValue(entries, 'direction'),
        'scrollUntilVisible.direction',
        context,
      )
    : undefined;
  const timeout = hasEntry(entries, 'timeout')
    ? readOptionalNumber(entryValue(entries, 'timeout'), 'scrollUntilVisible.timeout', context)
    : undefined;
  return stripUndefined({
    kind: 'scrollUntilVisible' as const,
    source,
    element,
    direction,
    timeout,
    ...options,
  });
}

function parseHideKeyboard(
  value: Node | null,
  commandNode: Node,
  context: MaestroProgramParseContext,
): MaestroHideKeyboardCommand {
  if (!isNullNode(value))
    invalidAt('Maestro hideKeyboard does not accept options.', commandNode, context);
  return { kind: 'hideKeyboard', source: sourceAt(commandNode, context) };
}

function parsePressKey(
  value: Node | null,
  commandNode: Node,
  context: MaestroProgramParseContext,
): MaestroPressKeyCommand {
  const key = readRequiredString(value, 'pressKey', context).toLowerCase();
  if (key !== 'back' && key !== 'enter' && key !== 'return' && key !== 'home')
    invalidAt(`Maestro pressKey "${key}" is not supported.`, value, context);
  return { kind: 'pressKey', source: sourceAt(commandNode, context), key };
}

function parseBack(
  value: Node | null,
  commandNode: Node,
  context: MaestroProgramParseContext,
): MaestroBackCommand {
  if (!isNullNode(value)) invalidAt('Maestro back does not accept options.', commandNode, context);
  return { kind: 'back', source: sourceAt(commandNode, context) };
}

function parseWaitForAnimationToEnd(
  value: Node | null,
  commandNode: Node,
  context: MaestroProgramParseContext,
): MaestroWaitForAnimationToEndCommand {
  const source = sourceAt(commandNode, context);
  if (isNullNode(value)) return { kind: 'waitForAnimationToEnd', source };
  if (isScalar(value)) {
    const timeout = readOptionalNumber(value, 'waitForAnimationToEnd', context);
    return stripUndefined({ kind: 'waitForAnimationToEnd' as const, source, timeout });
  }
  const entries = readMapEntries(value, 'waitForAnimationToEnd', context);
  assertOnlyKeys(entries, 'waitForAnimationToEnd', ['timeout'], context);
  const timeout = hasEntry(entries, 'timeout')
    ? readOptionalNumber(entryValue(entries, 'timeout'), 'waitForAnimationToEnd.timeout', context)
    : undefined;
  return stripUndefined({ kind: 'waitForAnimationToEnd' as const, source, timeout });
}

function parseStopApp(
  value: Node | null,
  commandNode: Node,
  context: MaestroProgramParseContext,
): MaestroStopAppCommand {
  const source = sourceAt(commandNode, context);
  if (isNullNode(value)) return { kind: 'stopApp', source };
  return { kind: 'stopApp', source, appId: readRequiredString(value, 'stopApp', context) };
}

function parseLaunchArguments(
  node: Node | null | undefined,
  name: string,
  context: MaestroProgramParseContext,
): MaestroLaunchArguments {
  if (isSeq(node)) {
    const values = readSequenceItems(node, name, context).map((item, index) => {
      const value = readScalarValue(item, `${name}[${index}]`, context);
      if (value === null) invalidAt(`${name}[${index}] expects a scalar value.`, item, context);
      return value;
    });
    return { kind: 'list', values };
  }
  if (isMap(node)) return { kind: 'map', values: readScalarMap(node, name, context) };
  const value = readScalarValue(node, name, context);
  if (value === null) invalidAt(`${name} expects a scalar, list, or map.`, node, context);
  return { kind: 'scalar', value };
}

function readOptionalPositiveInteger(
  node: Node | null | undefined,
  name: string,
  context: MaestroProgramParseContext,
): number | undefined {
  const value = readOptionalNonNegativeInteger(node, name, context);
  if (value !== undefined && value === 0)
    invalidAt(`Maestro ${name} expects a positive integer.`, node, context);
  return value;
}
