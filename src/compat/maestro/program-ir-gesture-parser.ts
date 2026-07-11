import { isScalar, type Node } from 'yaml';
import type {
  MaestroCoordinate,
  MaestroDirection,
  MaestroDoubleTapOnCommand,
  MaestroGestureTarget,
  MaestroLongPressOnCommand,
  MaestroSelector,
  MaestroSelectorMap,
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
  readOptionalBoolean,
  readOptionalEntry,
  readOptionalNonNegativeInteger,
  readOptionalNumber,
  readOptionalString,
  readRequiredPositiveInteger,
  readRequiredString,
  sourceAt,
  type MaestroMapEntry,
  type MaestroProgramParseContext,
} from './program-ir-values.ts';

const SELECTOR_KEYS = ['id', 'text', 'label', 'enabled', 'selected'] as const;

type SelectorFieldReader = (
  selector: MaestroSelectorMap,
  entry: MaestroMapEntry,
  name: string,
  context: MaestroProgramParseContext,
) => void;

const SELECTOR_FIELD_READERS: Readonly<Record<string, SelectorFieldReader>> = {
  id: (selector, entry, name, context) =>
    assignStringSelector(selector, 'id', entry, name, context),
  text: (selector, entry, name, context) =>
    assignStringSelector(selector, 'text', entry, name, context),
  label: (selector, entry, name, context) =>
    assignStringSelector(selector, 'label', entry, name, context),
  enabled: (selector, entry, name, context) =>
    assignBooleanSelector(selector, 'enabled', entry, name, context),
  selected: (selector, entry, name, context) =>
    assignBooleanSelector(selector, 'selected', entry, name, context),
};

export function parseMaestroSelector(
  node: Node | null | undefined,
  name: string,
  context: MaestroProgramParseContext,
): MaestroSelector {
  if (isScalar(node)) return { text: readRequiredString(node, name, context) };
  const entries = readMapEntries(node, name, context);
  assertOnlyKeys(entries, name, SELECTOR_KEYS, context);
  return parseSelectorEntries(entries, name, context);
}

export function parseMaestroTapOnCommand(
  value: Node | null,
  commandNode: Node,
  context: MaestroProgramParseContext,
): MaestroTapOnCommand {
  const source = sourceAt(commandNode, context);
  if (isScalar(value)) {
    return {
      kind: 'tapOn',
      source,
      target: selectorTarget(parseMaestroSelector(value, 'tapOn', context)),
    };
  }

  const entries = readMapEntries(value, 'tapOn', context);
  if (hasEntry(entries, 'point')) {
    assertOnlyKeys(entries, 'tapOn', ['point', 'repeat', 'delay', 'optional', 'label'], context);
    return {
      kind: 'tapOn',
      source,
      target: parsePoint(entryValue(entries, 'point'), 'tapOn.point', context),
      ...tapOptions(entries, context, true),
    };
  }

  assertOnlyKeys(
    entries,
    'tapOn',
    [...SELECTOR_KEYS, 'repeat', 'delay', 'optional', 'index', 'childOf'],
    context,
  );
  const selectorEntries = entries.filter((entry) => isSelectorKey(entry.key));
  const childOf = hasEntry(entries, 'childOf')
    ? parseMaestroSelector(entryValue(entries, 'childOf'), 'tapOn.childOf', context)
    : undefined;
  const options = tapOptions(entries, context, false);
  const index = hasEntry(entries, 'index')
    ? readOptionalNonNegativeInteger(entryValue(entries, 'index'), 'tapOn.index', context)
    : undefined;
  return {
    kind: 'tapOn',
    source,
    target: selectorTarget(parseSelectorEntries(selectorEntries, 'tapOn', context)),
    ...options,
    ...(index === undefined ? {} : { index }),
    ...(childOf === undefined ? {} : { childOf }),
  };
}

export function parseMaestroDoubleTapOnCommand(
  value: Node | null,
  commandNode: Node,
  context: MaestroProgramParseContext,
): MaestroDoubleTapOnCommand {
  const source = sourceAt(commandNode, context);
  if (isScalar(value)) {
    return {
      kind: 'doubleTapOn',
      source,
      target: selectorTarget(parseMaestroSelector(value, 'doubleTapOn', context)),
    };
  }
  const entries = readMapEntries(value, 'doubleTapOn', context);
  assertOnlyKeys(entries, 'doubleTapOn', ['point', ...SELECTOR_KEYS, 'delay'], context);
  const delay = hasEntry(entries, 'delay')
    ? readOptionalNonNegativeInteger(entryValue(entries, 'delay'), 'doubleTapOn.delay', context)
    : undefined;
  if (hasEntry(entries, 'point')) {
    if (entries.some((entry) => isSelectorKey(entry.key))) {
      invalidAt(
        'Maestro doubleTapOn.point cannot be combined with a selector.',
        commandNode,
        context,
      );
    }
    return {
      kind: 'doubleTapOn',
      source,
      target: parseAbsolutePoint(entryValue(entries, 'point'), 'doubleTapOn.point', context),
      ...(delay === undefined ? {} : { delay }),
    };
  }
  return {
    kind: 'doubleTapOn',
    source,
    target: selectorTarget(
      parseSelectorEntries(
        entries.filter((entry) => isSelectorKey(entry.key)),
        'doubleTapOn',
        context,
      ),
    ),
    ...(delay === undefined ? {} : { delay }),
  };
}

export function parseMaestroLongPressOnCommand(
  value: Node | null,
  commandNode: Node,
  context: MaestroProgramParseContext,
): MaestroLongPressOnCommand {
  const source = sourceAt(commandNode, context);
  if (isScalar(value)) {
    return {
      kind: 'longPressOn',
      source,
      target: selectorTarget(parseMaestroSelector(value, 'longPressOn', context)),
    };
  }
  const entries = readMapEntries(value, 'longPressOn', context);
  assertOnlyKeys(entries, 'longPressOn', ['point', ...SELECTOR_KEYS], context);
  if (hasEntry(entries, 'point')) {
    if (entries.some((entry) => isSelectorKey(entry.key))) {
      invalidAt(
        'Maestro longPressOn.point cannot be combined with a selector.',
        commandNode,
        context,
      );
    }
    return {
      kind: 'longPressOn',
      source,
      target: parseAbsolutePoint(entryValue(entries, 'point'), 'longPressOn.point', context),
    };
  }
  return {
    kind: 'longPressOn',
    source,
    target: selectorTarget(parseSelectorEntries(entries, 'longPressOn', context)),
  };
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
    ['start', 'end', 'direction', 'duration', 'from', 'label'],
    context,
  );
  const duration = hasEntry(entries, 'duration')
    ? readOptionalNumber(entryValue(entries, 'duration'), 'swipe.duration', context)
    : undefined;
  if (hasEntry(entries, 'start') || hasEntry(entries, 'end')) {
    return parseCoordinateSwipe(entries, source, duration, commandNode, context);
  }
  const direction = hasEntry(entries, 'direction')
    ? parseMaestroDirection(entryValue(entries, 'direction'), 'swipe.direction', context)
    : undefined;
  if (hasEntry(entries, 'from') || hasEntry(entries, 'label')) {
    return parseTargetSwipe(entries, source, direction, duration, context);
  }
  return parseScreenSwipe(source, direction, duration, commandNode, context);
}

function parseCoordinateSwipe(
  entries: readonly MaestroMapEntry[],
  source: MaestroSourceLocation,
  duration: number | undefined,
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
  const start = parsePoint(entryValue(entries, 'start'), 'swipe.start', context);
  const end = parsePoint(entryValue(entries, 'end'), 'swipe.end', context);
  if (start.space !== end.space) {
    invalidAt('Maestro swipe start/end must use the same coordinate space.', commandNode, context);
  }
  return {
    kind: 'swipe',
    source,
    gesture: {
      kind: 'coordinates',
      start,
      end,
      ...(duration === undefined ? {} : { duration }),
    },
  };
}

function parseTargetSwipe(
  entries: readonly MaestroMapEntry[],
  source: MaestroSourceLocation,
  direction: MaestroDirection | undefined,
  duration: number | undefined,
  context: MaestroProgramParseContext,
): MaestroSwipeCommand {
  const label = hasEntry(entries, 'label')
    ? readOptionalString(entryValue(entries, 'label'), 'swipe.label', context)
    : undefined;
  const from = hasEntry(entries, 'from')
    ? parseMaestroSelector(entryValue(entries, 'from'), 'swipe.from', context)
    : { text: label ?? '' };
  return {
    kind: 'swipe',
    source,
    gesture: {
      kind: 'target',
      from,
      ...(direction === undefined ? {} : { direction }),
      ...(duration === undefined ? {} : { duration }),
      ...(label === undefined ? {} : { label }),
    },
  };
}

function parseScreenSwipe(
  source: MaestroSourceLocation,
  direction: MaestroDirection | undefined,
  duration: number | undefined,
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
    gesture: { kind: 'screen', direction, ...(duration === undefined ? {} : { duration }) },
  };
}

function tapOptions(
  entries: readonly MaestroMapEntry[],
  context: MaestroProgramParseContext,
  includeLabel: boolean,
): Pick<MaestroTapOnCommand, 'repeat' | 'delay' | 'optional' | 'label'> {
  const repeat = readOptionalEntry(entries, 'repeat', (entry) =>
    readRequiredPositiveInteger(entry, 'tapOn.repeat', context),
  );
  const delay = readOptionalEntry(entries, 'delay', (entry) =>
    readOptionalNonNegativeInteger(entry, 'tapOn.delay', context),
  );
  const optional = readOptionalEntry(entries, 'optional', (entry) =>
    readOptionalBoolean(entry, 'tapOn.optional', context),
  );
  const label = includeLabel
    ? readOptionalEntry(entries, 'label', (entry) =>
        readOptionalString(entry, 'tapOn.label', context),
      )
    : undefined;
  return {
    ...(repeat === undefined ? {} : { repeat }),
    ...(delay === undefined ? {} : { delay }),
    ...(optional === undefined ? {} : { optional }),
    ...(label === undefined ? {} : { label }),
  };
}

function parseSelectorEntries(
  entries: readonly MaestroMapEntry[],
  name: string,
  context: MaestroProgramParseContext,
): MaestroSelectorMap {
  if (entries.length === 0) invalidAt(`Maestro ${name} selector is empty.`, undefined, context);
  const selector: MaestroSelectorMap = {};
  for (const entry of entries) {
    const read = SELECTOR_FIELD_READERS[entry.key];
    if (!read) {
      invalidAt(
        `Maestro ${name} selector field "${entry.key}" is not supported.`,
        entry.keyNode,
        context,
      );
    }
    read(selector, entry, name, context);
  }
  if (Object.keys(selector).length === 0) {
    invalidAt(
      `Maestro ${name} selector must contain a selector value.`,
      entries[0]?.keyNode,
      context,
    );
  }
  return selector;
}

function assignStringSelector(
  selector: MaestroSelectorMap,
  key: 'id' | 'text' | 'label',
  entry: MaestroMapEntry,
  name: string,
  context: MaestroProgramParseContext,
): void {
  const value = readOptionalString(entry.value, `${name}.${key}`, context);
  if (value !== undefined) selector[key] = value;
}

function assignBooleanSelector(
  selector: MaestroSelectorMap,
  key: 'enabled' | 'selected',
  entry: MaestroMapEntry,
  name: string,
  context: MaestroProgramParseContext,
): void {
  const value = readOptionalBoolean(entry.value, `${name}.${key}`, context);
  if (value !== undefined) selector[key] = value;
}

function isSelectorKey(key: string): key is (typeof SELECTOR_KEYS)[number] {
  return (SELECTOR_KEYS as readonly string[]).includes(key);
}

function parsePoint(
  node: Node | null | undefined,
  name: string,
  context: MaestroProgramParseContext,
): MaestroCoordinate {
  const value = readRequiredString(node, name, context);
  const absolute = /^\s*(\d+)\s*,\s*(\d+)\s*$/.exec(value);
  if (absolute) return { space: 'absolute', x: Number(absolute[1]), y: Number(absolute[2]) };
  const percent = /^\s*(\d+(?:\.\d+)?)%\s*,\s*(\d+(?:\.\d+)?)%\s*$/.exec(value);
  if (percent) return { space: 'percent', x: Number(percent[1]), y: Number(percent[2]) };
  invalidAt(`Maestro ${name} expects absolute or percentage coordinates.`, node, context);
}

function parseAbsolutePoint(
  node: Node | null | undefined,
  name: string,
  context: MaestroProgramParseContext,
): MaestroCoordinate {
  const point = parsePoint(node, name, context);
  if (point.space !== 'absolute')
    invalidAt(`Maestro ${name} only supports absolute coordinates.`, node, context);
  return point;
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

function selectorTarget(selector: MaestroSelector): MaestroGestureTarget {
  return { space: 'target', selector };
}
