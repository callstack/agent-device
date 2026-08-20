import { type Node } from 'yaml';
import { stripUndefined } from './shared.ts';
import type {
  MaestroDirection,
  MaestroDoubleTapOnCommand,
  MaestroLongPressOnCommand,
  MaestroSourceLocation,
  MaestroSwipeCommand,
  MaestroTapOnCommand,
} from './program-ir.ts';
import {
  assertOnlyKeys,
  entryValue,
  hasEntry,
  invalidAt,
  readMapEntries,
  readOptionalCommandOption,
  readOptionalBoolean,
  readOptionalEntry,
  readOptionalNumeric,
  readRequiredNumeric,
  readRequiredString,
  sourceAt,
  type MaestroMapEntry,
  type MaestroProgramParseContext,
} from './program-ir-values.ts';
import { readMaestroCommandLabel } from './program-ir-command-options.ts';
import {
  parseMaestroAbsolutePoint,
  parseMaestroPoint,
  parseMaestroSelector,
  parsePointOrSelectorTarget,
} from './program-ir-selector-parser.ts';
import { MAESTRO_BASE_SELECTOR_KEYS } from './selector-vocabulary.ts';

export function parseMaestroTapOnCommand(
  value: Node | null,
  commandNode: Node,
  context: MaestroProgramParseContext,
): MaestroTapOnCommand {
  const parsed = parsePointOrSelectorTarget(value, commandNode, context, {
    name: 'tapOn',
    selectorKeys: MAESTRO_BASE_SELECTOR_KEYS,
    pointConflictingSelectorKeys: MAESTRO_BASE_SELECTOR_KEYS,
    pointAllowedKeys: ['point', 'retryTapIfNoChange', 'repeat', 'delay', 'optional', 'label'],
    selectorAllowedKeys: [
      ...MAESTRO_BASE_SELECTOR_KEYS,
      'retryTapIfNoChange',
      'repeat',
      'delay',
      'optional',
      'label',
      'index',
      'childOf',
    ],
    parsePoint: parseMaestroPoint,
  });
  if (parsed.entries.length === 0) {
    return { kind: 'tapOn', source: parsed.source, target: parsed.target };
  }
  if (parsed.target.space !== 'target') {
    return {
      kind: 'tapOn',
      source: parsed.source,
      target: parsed.target,
      ...tapOptions(parsed.entries, context),
    };
  }
  const childOf = hasEntry(parsed.entries, 'childOf')
    ? parseMaestroSelector(entryValue(parsed.entries, 'childOf'), 'tapOn.childOf', context)
    : undefined;
  const options = tapOptions(parsed.entries, context);
  const index = hasEntry(parsed.entries, 'index')
    ? readOptionalNumeric(entryValue(parsed.entries, 'index'), 'tapOn.index', context)
    : undefined;
  return stripUndefined({
    kind: 'tapOn' as const,
    source: parsed.source,
    target: parsed.target,
    ...options,
    index,
    childOf,
  });
}

export function parseMaestroDoubleTapOnCommand(
  value: Node | null,
  commandNode: Node,
  context: MaestroProgramParseContext,
): MaestroDoubleTapOnCommand {
  const parsed = parsePointOrSelectorTarget(value, commandNode, context, {
    name: 'doubleTapOn',
    selectorKeys: MAESTRO_BASE_SELECTOR_KEYS,
    pointAllowedKeys: ['point', 'delay', 'optional', 'label'],
    selectorAllowedKeys: [...MAESTRO_BASE_SELECTOR_KEYS, 'delay', 'optional', 'label'],
    parsePoint: parseMaestroAbsolutePoint,
  });
  const options = readOptionalCommandOption(parsed.entries, 'doubleTapOn', context);
  const delay = hasEntry(parsed.entries, 'delay')
    ? readOptionalNumeric(entryValue(parsed.entries, 'delay'), 'doubleTapOn.delay', context)
    : undefined;
  const label = readMaestroCommandLabel(parsed.entries, 'doubleTapOn', context);
  return stripUndefined({
    kind: 'doubleTapOn' as const,
    source: parsed.source,
    target: parsed.target,
    ...options,
    delay,
    label,
  });
}

export function parseMaestroLongPressOnCommand(
  value: Node | null,
  commandNode: Node,
  context: MaestroProgramParseContext,
): MaestroLongPressOnCommand {
  const parsed = parsePointOrSelectorTarget(value, commandNode, context, {
    name: 'longPressOn',
    selectorKeys: MAESTRO_BASE_SELECTOR_KEYS,
    pointAllowedKeys: ['point', 'optional', 'label'],
    selectorAllowedKeys: [...MAESTRO_BASE_SELECTOR_KEYS, 'optional', 'label'],
    parsePoint: parseMaestroAbsolutePoint,
  });
  return stripUndefined({
    kind: 'longPressOn',
    source: parsed.source,
    target: parsed.target,
    ...readOptionalCommandOption(parsed.entries, 'longPressOn', context),
    label: readMaestroCommandLabel(parsed.entries, 'longPressOn', context),
  });
}

export function parseMaestroSwipeCommand(
  value: Node | null,
  commandNode: Node,
  context: MaestroProgramParseContext,
): MaestroSwipeCommand {
  const source = sourceAt(commandNode, context);
  const entries = readMapEntries(value, 'swipe', context);
  assertOnlyKeys(
    entries,
    'swipe',
    ['start', 'end', 'direction', 'duration', 'from', 'label', 'optional'],
    context,
  );
  const options = readOptionalCommandOption(entries, 'swipe', context);
  const label = readMaestroCommandLabel(entries, 'swipe', context);
  const duration = hasEntry(entries, 'duration')
    ? readOptionalNumeric(entryValue(entries, 'duration'), 'swipe.duration', context)
    : undefined;
  if (hasEntry(entries, 'start') || hasEntry(entries, 'end')) {
    return {
      ...parseCoordinateSwipe(entries, source, duration, commandNode, context),
      ...options,
      label,
    };
  }
  const direction = hasEntry(entries, 'direction')
    ? parseMaestroDirection(entryValue(entries, 'direction'), 'swipe.direction', context)
    : undefined;
  if (hasEntry(entries, 'from')) {
    return {
      ...parseTargetSwipe(entries, source, direction, duration, commandNode, context),
      ...options,
      label,
    };
  }
  return {
    ...parseScreenSwipe(source, direction, duration, commandNode, context),
    ...options,
    label,
  };
}

function parseCoordinateSwipe(
  entries: readonly MaestroMapEntry[],
  source: MaestroSourceLocation,
  duration: number | string | undefined,
  commandNode: Node,
  context: MaestroProgramParseContext,
): MaestroSwipeCommand {
  if (hasEntry(entries, 'direction')) {
    invalidAt(
      'Maestro swipe cannot combine direction with start/end coordinates.',
      commandNode,
      context,
    );
  }
  if (!hasEntry(entries, 'start') || !hasEntry(entries, 'end')) {
    invalidAt('Maestro swipe requires both start and end coordinates.', commandNode, context);
  }
  const start = parseMaestroPoint(entryValue(entries, 'start'), 'swipe.start', context);
  const end = parseMaestroPoint(entryValue(entries, 'end'), 'swipe.end', context);
  if (start.space !== end.space) {
    invalidAt('Maestro swipe start/end must use the same coordinate space.', commandNode, context);
  }
  return {
    kind: 'swipe',
    source,
    gesture: stripUndefined({
      kind: 'coordinates' as const,
      start,
      end,
      duration,
    }),
  };
}

function parseTargetSwipe(
  entries: readonly MaestroMapEntry[],
  source: MaestroSourceLocation,
  direction: MaestroDirection | undefined,
  duration: number | string | undefined,
  commandNode: Node,
  context: MaestroProgramParseContext,
): MaestroSwipeCommand {
  if (direction === undefined) {
    invalidAt('Maestro target swipe requires direction.', commandNode, context);
  }
  const from = parseMaestroSelector(entryValue(entries, 'from'), 'swipe.from', context);
  return {
    kind: 'swipe',
    source,
    gesture: stripUndefined({
      kind: 'target' as const,
      from,
      direction,
      duration,
    }),
  };
}

function parseScreenSwipe(
  source: MaestroSourceLocation,
  direction: MaestroDirection | undefined,
  duration: number | string | undefined,
  commandNode: Node,
  context: MaestroProgramParseContext,
): MaestroSwipeCommand {
  if (direction === undefined) {
    invalidAt(
      'Maestro swipe requires direction, target, or start/end coordinates.',
      commandNode,
      context,
    );
  }
  return {
    kind: 'swipe',
    source,
    gesture: stripUndefined({ kind: 'screen' as const, direction, duration }),
  };
}

function tapOptions(
  entries: readonly MaestroMapEntry[],
  context: MaestroProgramParseContext,
): Pick<MaestroTapOnCommand, 'retryTapIfNoChange' | 'repeat' | 'delay' | 'optional' | 'label'> {
  const retryTapIfNoChange = readOptionalEntry(entries, 'retryTapIfNoChange', (entry) =>
    readOptionalBoolean(entry, 'tapOn.retryTapIfNoChange', context),
  );
  const repeat = readOptionalEntry(entries, 'repeat', (entry) =>
    readRequiredNumeric(entry, 'tapOn.repeat', context),
  );
  const delay = readOptionalEntry(entries, 'delay', (entry) =>
    readOptionalNumeric(entry, 'tapOn.delay', context),
  );
  const optional = readOptionalCommandOption(entries, 'tapOn', context).optional;
  const label = readMaestroCommandLabel(entries, 'tapOn', context);
  return stripUndefined({ retryTapIfNoChange, repeat, delay, optional, label });
}

export function parseMaestroDirection(
  node: Node | null | undefined,
  name: string,
  context: MaestroProgramParseContext,
): MaestroDirection {
  const value = readRequiredString(node, name, context).toLowerCase();
  if (value === 'up' || value === 'down' || value === 'left' || value === 'right') return value;
  invalidAt(`Maestro ${name} must be UP, DOWN, LEFT, or RIGHT.`, node, context);
}
