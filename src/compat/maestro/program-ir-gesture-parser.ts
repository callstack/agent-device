import { isScalar, type Node } from 'yaml';
import type {
  MaestroCoordinate,
  MaestroDirection,
  MaestroDoubleTapOnCommand,
  MaestroGestureTarget,
  MaestroLongPressOnCommand,
  MaestroSelector,
  MaestroSelectorMap,
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
  const repeat = hasEntry(entries, 'repeat')
    ? readRequiredPositiveInteger(entryValue(entries, 'repeat'), 'tapOn.repeat', context)
    : undefined;
  const delay = hasEntry(entries, 'delay')
    ? readOptionalNonNegativeInteger(entryValue(entries, 'delay'), 'tapOn.delay', context)
    : undefined;
  const optional = hasEntry(entries, 'optional')
    ? readOptionalBoolean(entryValue(entries, 'optional'), 'tapOn.optional', context)
    : undefined;
  const index = hasEntry(entries, 'index')
    ? readOptionalNonNegativeInteger(entryValue(entries, 'index'), 'tapOn.index', context)
    : undefined;
  return {
    kind: 'tapOn',
    source,
    target: selectorTarget(parseSelectorEntries(selectorEntries, 'tapOn', context)),
    ...(repeat === undefined ? {} : { repeat }),
    ...(delay === undefined ? {} : { delay }),
    ...(optional === undefined ? {} : { optional }),
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
      invalidAt(
        'Maestro swipe start/end must use the same coordinate space.',
        commandNode,
        context,
      );
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

  const hasFrom = hasEntry(entries, 'from');
  const hasLabel = hasEntry(entries, 'label');
  const direction = hasEntry(entries, 'direction')
    ? parseMaestroDirection(entryValue(entries, 'direction'), 'swipe.direction', context)
    : undefined;
  if (hasFrom || hasLabel) {
    const label = hasLabel
      ? readOptionalString(entryValue(entries, 'label'), 'swipe.label', context)
      : undefined;
    const from = hasFrom
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
    gesture: {
      kind: 'screen',
      direction,
      ...(duration === undefined ? {} : { duration }),
    },
  };
}

function tapOptions(
  entries: readonly MaestroMapEntry[],
  context: MaestroProgramParseContext,
  includeLabel: boolean,
): Pick<MaestroTapOnCommand, 'repeat' | 'delay' | 'optional' | 'label'> {
  const repeat = hasEntry(entries, 'repeat')
    ? readRequiredPositiveInteger(entryValue(entries, 'repeat'), 'tapOn.repeat', context)
    : undefined;
  const delay = hasEntry(entries, 'delay')
    ? readOptionalNonNegativeInteger(entryValue(entries, 'delay'), 'tapOn.delay', context)
    : undefined;
  const optional = hasEntry(entries, 'optional')
    ? readOptionalBoolean(entryValue(entries, 'optional'), 'tapOn.optional', context)
    : undefined;
  const label =
    includeLabel && hasEntry(entries, 'label')
      ? readOptionalString(entryValue(entries, 'label'), 'tapOn.label', context)
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
    switch (entry.key) {
      case 'id': {
        const value = readOptionalString(entry.value, `${name}.id`, context);
        if (value !== undefined) selector.id = value;
        break;
      }
      case 'text': {
        const value = readOptionalString(entry.value, `${name}.text`, context);
        if (value !== undefined) selector.text = value;
        break;
      }
      case 'label': {
        const value = readOptionalString(entry.value, `${name}.label`, context);
        if (value !== undefined) selector.label = value;
        break;
      }
      case 'enabled': {
        const value = readOptionalBoolean(entry.value, `${name}.enabled`, context);
        if (value !== undefined) selector.enabled = value;
        break;
      }
      case 'selected': {
        const value = readOptionalBoolean(entry.value, `${name}.selected`, context);
        if (value !== undefined) selector.selected = value;
        break;
      }
      default:
        invalidAt(
          `Maestro ${name} selector field "${entry.key}" is not supported.`,
          entry.keyNode,
          context,
        );
    }
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
