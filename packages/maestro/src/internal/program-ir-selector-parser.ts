import { isScalar, type Node } from 'yaml';
import type {
  MaestroCoordinate,
  MaestroGestureTarget,
  MaestroSelector,
  MaestroSelectorMap,
  MaestroSourceLocation,
} from './program-ir.ts';
import {
  assertOnlyKeys,
  entryValue,
  hasEntry,
  invalidAt,
  readMapEntries,
  readOptionalBoolean,
  readOptionalString,
  readOptionalNumeric,
  readSequenceItems,
  readRequiredString,
  sourceAt,
  type MaestroMapEntry,
  type MaestroProgramParseContext,
} from './program-ir-values.ts';
import { MAESTRO_BASE_SELECTOR_KEYS, type MaestroSelectorKey } from './selector-vocabulary.ts';

type SelectorFieldReader = (
  selector: MaestroSelectorMap,
  entry: MaestroMapEntry,
  name: string,
  context: MaestroProgramParseContext,
) => void;

export type ParsedPointOrSelectorTarget = {
  readonly source: MaestroSourceLocation;
  readonly entries: readonly MaestroMapEntry[];
  readonly target: MaestroGestureTarget;
};

const SELECTOR_FIELD_READERS: Readonly<Record<string, SelectorFieldReader>> = {
  id: (selector, entry, name, context) =>
    assignStringSelector(selector, 'id', entry, name, context),
  text: (selector, entry, name, context) =>
    assignStringSelector(selector, 'text', entry, name, context),
  enabled: (selector, entry, name, context) =>
    assignBooleanSelector(selector, 'enabled', entry, name, context),
  selected: (selector, entry, name, context) =>
    assignBooleanSelector(selector, 'selected', entry, name, context),
  index: (selector, entry, name, context) => {
    selector.index = readOptionalNumeric(entry.value, `${name}.index`, context, {
      integer: true,
      nonNegative: true,
    });
  },
  childOf: (selector, entry, name, context) => {
    selector.childOf = parseMaestroSelector(entry.value, `${name}.childOf`, context);
  },
  below: (selector, entry, name, context) => {
    selector.below = parseMaestroSelector(entry.value, `${name}.below`, context);
  },
  above: (selector, entry, name, context) => {
    selector.above = parseMaestroSelector(entry.value, `${name}.above`, context);
  },
  leftOf: (selector, entry, name, context) => {
    selector.leftOf = parseMaestroSelector(entry.value, `${name}.leftOf`, context);
  },
  rightOf: (selector, entry, name, context) => {
    selector.rightOf = parseMaestroSelector(entry.value, `${name}.rightOf`, context);
  },
  containsChild: (selector, entry, name, context) => {
    selector.containsChild = parseMaestroSelector(entry.value, `${name}.containsChild`, context);
  },
  containsDescendants: (selector, entry, name, context) => {
    selector.containsDescendants = readSequenceItems(
      entry.value,
      `${name}.containsDescendants`,
      context,
    ).map((item) => parseMaestroSelector(item, `${name}.containsDescendants`, context));
  },
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

export function parsePointOrSelectorTarget(
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

export function parseMaestroPoint(
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

export function parseMaestroAbsolutePoint(
  node: Node | null | undefined,
  name: string,
  context: MaestroProgramParseContext,
): MaestroCoordinate {
  const point = parseMaestroPoint(node, name, context);
  if (point.space !== 'absolute')
    invalidAt(`Maestro ${name} only supports absolute coordinates.`, node, context);
  return point;
}

function assignStringSelector(
  selector: MaestroSelectorMap,
  key: 'id' | 'text',
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

function selectorTarget(selector: MaestroSelector): MaestroGestureTarget {
  return { space: 'target', selector };
}
