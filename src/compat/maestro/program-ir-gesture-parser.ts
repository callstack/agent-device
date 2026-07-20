import { isScalar, type Node } from 'yaml';
import { stripUndefined } from '../../utils/parsing.ts';
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
  readOptionalCommandOption,
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
import {
  MAESTRO_BASE_SELECTOR_KEYS,
  MAESTRO_TAP_SELECTOR_KEYS,
  type MaestroSelectorKey,
} from './selector-vocabulary.ts';

type SelectorFieldReader = (
  selector: MaestroSelectorMap,
  entry: MaestroMapEntry,
  name: string,
  context: MaestroProgramParseContext,
) => void;

type ParsedPointOrSelectorTarget = {
  readonly source: MaestroSourceLocation;
  readonly entries: readonly MaestroMapEntry[];
  readonly target: MaestroGestureTarget;
};

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
  optional: (selector, entry, name, context) =>
    assignBooleanSelector(selector, 'optional', entry, name, context),
};

export function parseMaestroSelector(
  node: Node | null | undefined,
  name: string,
  context: MaestroProgramParseContext,
  selectorKeys: readonly MaestroSelectorKey[] = MAESTRO_BASE_SELECTOR_KEYS,
): MaestroSelector {
  if (isScalar(node)) return { text: readRequiredString(node, name, context) };
  const entries = readMapEntries(node, name, context);
  assertOnlyKeys(entries, name, selectorKeys, context);
  return parseMaestroSelectorMapEntries(entries, name, context);
}

export function parseMaestroSelectorMapEntries(
  entries: readonly MaestroMapEntry[],
  name: string,
  context: MaestroProgramParseContext,
): MaestroSelector {
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
  const matchingKeys = Object.keys(selector).filter((key) => key !== 'optional');
  if (matchingKeys.length === 0) {
    invalidAt(
      `Maestro ${name} selector must contain a selector value.`,
      entries[0]?.keyNode,
      context,
    );
  }
  return selector;
}

export function parseMaestroTapOnCommand(
  value: Node | null,
  commandNode: Node,
  context: MaestroProgramParseContext,
): MaestroTapOnCommand {
  const parsed = parsePointOrSelectorTarget(value, commandNode, context, {
    name: 'tapOn',
    selectorKeys: MAESTRO_TAP_SELECTOR_KEYS,
    pointConflictingSelectorKeys: MAESTRO_BASE_SELECTOR_KEYS,
    pointAllowedKeys: ['point', 'retryTapIfNoChange', 'repeat', 'delay', 'optional', 'label'],
    selectorAllowedKeys: [
      ...MAESTRO_TAP_SELECTOR_KEYS,
      'retryTapIfNoChange',
      'repeat',
      'delay',
      'optional',
      'index',
      'childOf',
    ],
    parsePoint,
  });
  if (parsed.entries.length === 0) {
    return { kind: 'tapOn', source: parsed.source, target: parsed.target };
  }
  if (parsed.target.space !== 'target') {
    return {
      kind: 'tapOn',
      source: parsed.source,
      target: parsed.target,
      ...tapOptions(parsed.entries, context, true),
    };
  }
  const childOf = hasEntry(parsed.entries, 'childOf')
    ? parseMaestroSelector(entryValue(parsed.entries, 'childOf'), 'tapOn.childOf', context)
    : undefined;
  const options = tapOptions(parsed.entries, context, false);
  const index = hasEntry(parsed.entries, 'index')
    ? readOptionalNonNegativeInteger(entryValue(parsed.entries, 'index'), 'tapOn.index', context)
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
    pointAllowedKeys: ['point', 'delay', 'optional'],
    selectorAllowedKeys: [...MAESTRO_BASE_SELECTOR_KEYS, 'delay', 'optional'],
    parsePoint: parseAbsolutePoint,
  });
  const options = readOptionalCommandOption(parsed.entries, 'doubleTapOn', context);
  const delay = hasEntry(parsed.entries, 'delay')
    ? readOptionalNonNegativeInteger(
        entryValue(parsed.entries, 'delay'),
        'doubleTapOn.delay',
        context,
      )
    : undefined;
  return stripUndefined({
    kind: 'doubleTapOn' as const,
    source: parsed.source,
    target: parsed.target,
    ...options,
    delay,
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
    pointAllowedKeys: ['point', 'optional'],
    selectorAllowedKeys: [...MAESTRO_BASE_SELECTOR_KEYS, 'optional'],
    parsePoint: parseAbsolutePoint,
  });
  return {
    kind: 'longPressOn',
    source: parsed.source,
    target: parsed.target,
    ...readOptionalCommandOption(parsed.entries, 'longPressOn', context),
  };
}

function parsePointOrSelectorTarget(
  value: Node | null,
  commandNode: Node,
  context: MaestroProgramParseContext,
  options: {
    readonly name: string;
    readonly selectorKeys: readonly MaestroSelectorKey[];
    readonly pointConflictingSelectorKeys?: readonly MaestroSelectorKey[];
    readonly pointAllowedKeys: readonly string[];
    readonly selectorAllowedKeys: readonly string[];
    readonly parsePoint: (
      node: Node | null | undefined,
      name: string,
      context: MaestroProgramParseContext,
    ) => MaestroCoordinate;
  },
): ParsedPointOrSelectorTarget {
  const source = sourceAt(commandNode, context);
  if (isScalar(value)) {
    return {
      source,
      entries: [],
      target: selectorTarget(
        parseMaestroSelector(value, options.name, context, options.selectorKeys),
      ),
    };
  }
  const entries = readMapEntries(value, options.name, context);
  const hasPoint = hasEntry(entries, 'point');
  assertOnlyKeys(
    entries,
    options.name,
    hasPoint ? options.pointAllowedKeys : options.selectorAllowedKeys,
    context,
  );
  if (hasPoint) {
    const conflictingKeys = options.pointConflictingSelectorKeys ?? options.selectorKeys;
    if (entries.some((entry) => isSelectorKey(entry.key, conflictingKeys))) {
      invalidAt(
        `Maestro ${options.name}.point cannot be combined with a selector.`,
        commandNode,
        context,
      );
    }
    return {
      source,
      entries,
      target: options.parsePoint(entryValue(entries, 'point'), `${options.name}.point`, context),
    };
  }
  const selectorEntries = entries.filter((entry) => isSelectorKey(entry.key, options.selectorKeys));
  return {
    source,
    entries,
    target: selectorTarget(parseMaestroSelectorMapEntries(selectorEntries, options.name, context)),
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
    ['start', 'end', 'direction', 'duration', 'from', 'label', 'optional'],
    context,
  );
  const options = readOptionalCommandOption(entries, 'swipe', context);
  const duration = hasEntry(entries, 'duration')
    ? readOptionalNumber(entryValue(entries, 'duration'), 'swipe.duration', context)
    : undefined;
  if (hasEntry(entries, 'start') || hasEntry(entries, 'end')) {
    return { ...parseCoordinateSwipe(entries, source, duration, commandNode, context), ...options };
  }
  const direction = hasEntry(entries, 'direction')
    ? parseMaestroDirection(entryValue(entries, 'direction'), 'swipe.direction', context)
    : undefined;
  if (hasEntry(entries, 'from') || hasEntry(entries, 'label')) {
    return {
      ...parseTargetSwipe(entries, source, direction, duration, commandNode, context),
      ...options,
    };
  }
  return { ...parseScreenSwipe(source, direction, duration, commandNode, context), ...options };
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
  duration: number | undefined,
  commandNode: Node,
  context: MaestroProgramParseContext,
): MaestroSwipeCommand {
  if (direction === undefined) {
    invalidAt('Maestro target swipe requires direction.', commandNode, context);
  }
  const label = hasEntry(entries, 'label')
    ? readOptionalString(entryValue(entries, 'label'), 'swipe.label', context)
    : undefined;
  const from = hasEntry(entries, 'from')
    ? parseMaestroSelector(entryValue(entries, 'from'), 'swipe.from', context)
    : { text: label ?? '' };
  return {
    kind: 'swipe',
    source,
    gesture: stripUndefined({
      kind: 'target' as const,
      from,
      direction,
      duration,
      label,
    }),
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
    gesture: stripUndefined({ kind: 'screen' as const, direction, duration }),
  };
}

function tapOptions(
  entries: readonly MaestroMapEntry[],
  context: MaestroProgramParseContext,
  includeLabel: boolean,
): Pick<MaestroTapOnCommand, 'retryTapIfNoChange' | 'repeat' | 'delay' | 'optional' | 'label'> {
  const retryTapIfNoChange = readOptionalEntry(entries, 'retryTapIfNoChange', (entry) =>
    readOptionalBoolean(entry, 'tapOn.retryTapIfNoChange', context),
  );
  const repeat = readOptionalEntry(entries, 'repeat', (entry) =>
    readRequiredPositiveInteger(entry, 'tapOn.repeat', context),
  );
  const delay = readOptionalEntry(entries, 'delay', (entry) =>
    readOptionalNonNegativeInteger(entry, 'tapOn.delay', context),
  );
  const optional = readOptionalCommandOption(entries, 'tapOn', context).optional;
  const label = includeLabel
    ? readOptionalEntry(entries, 'label', (entry) =>
        readOptionalString(entry, 'tapOn.label', context),
      )
    : undefined;
  return stripUndefined({ retryTapIfNoChange, repeat, delay, optional, label });
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
  key: 'enabled' | 'selected' | 'optional',
  entry: MaestroMapEntry,
  name: string,
  context: MaestroProgramParseContext,
): void {
  const value = readOptionalBoolean(entry.value, `${name}.${key}`, context);
  if (value !== undefined) selector[key] = value;
}

function isSelectorKey(
  key: string,
  selectorKeys: readonly MaestroSelectorKey[],
): key is MaestroSelectorKey {
  return selectorKeys.includes(key as MaestroSelectorKey);
}

function parsePoint(
  node: Node | null | undefined,
  name: string,
  context: MaestroProgramParseContext,
): MaestroCoordinate {
  const value = readRequiredString(node, name, context);
  const absolute = /^\s*(\d+)\s*,\s*(\d+)\s*$/.exec(value);
  if (absolute) return { space: 'absolute', x: Number(absolute[1]), y: Number(absolute[2]) };
  const percent = /^\s*(\d+)%\s*,\s*(\d+)%\s*$/.exec(value);
  if (percent) {
    const x = Number(percent[1]);
    const y = Number(percent[2]);
    if (x > 100 || y > 100) {
      invalidAt(
        `Maestro ${name} percentage coordinates must be between 0% and 100%.`,
        node,
        context,
      );
    }
    return { space: 'percent', x, y };
  }
  if (/^\s*\d+(?:\.\d+)?%\s*,\s*\d+(?:\.\d+)?%\s*$/.test(value)) {
    invalidAt(`Maestro ${name} percentage coordinates must be whole numbers.`, node, context);
  }
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
