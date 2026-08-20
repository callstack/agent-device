import { isScalar, type Node } from 'yaml';
import type {
  MaestroAssertNotVisibleCommand,
  MaestroAssertVisibleCommand,
  MaestroSelector,
} from './program-ir.ts';
import {
  assertOnlyKeys,
  entryValue,
  hasEntry,
  invalidAt,
  readMapEntries,
  readOptionalCommandOption,
  sourceAt,
  type MaestroMapEntry,
  type MaestroProgramParseContext,
} from './program-ir-values.ts';
import {
  parseMaestroSelector,
  parseMaestroSelectorMapEntries,
} from './program-ir-selector-parser.ts';
import { readMaestroCommandLabel } from './program-ir-command-options.ts';
import { stripUndefined } from './shared.ts';
import { MAESTRO_BASE_SELECTOR_KEYS } from './selector-vocabulary.ts';

export function parseMaestroAssertion(
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
  assertOnlyKeys(entries, kind, [...MAESTRO_BASE_SELECTOR_KEYS, 'optional', 'label'], context);
  const options = readOptionalCommandOption(entries, kind, context);
  const label = readMaestroCommandLabel(entries, kind, context);
  return stripUndefined({
    kind,
    source,
    target: parseMaestroSelectorMapEntries(
      entries.filter((entry) => entry.key !== 'optional' && entry.key !== 'label'),
      kind,
      context,
    ),
    ...options,
    label,
  });
}

const OPTIONAL_SELECTOR_KEYS = [...MAESTRO_BASE_SELECTOR_KEYS, 'optional'] as const;

type ParsedOptionalSelector = {
  selector: MaestroSelector;
  optional: boolean | undefined;
};

export function parseMaestroOptionalSelector(
  entries: readonly MaestroMapEntry[],
  key: string,
  name: string,
  context: MaestroProgramParseContext,
): ParsedOptionalSelector | undefined {
  if (!hasEntry(entries, key)) return undefined;
  const parsed = parseMaestroSelector(
    entryValue(entries, key),
    name,
    context,
    OPTIONAL_SELECTOR_KEYS,
  );
  const { optional: selectorOptional, ...selector } = parsed;
  return { selector, optional: selectorOptional };
}

export function parseMaestroExtendedWaitUntilCondition(
  entries: readonly MaestroMapEntry[],
  commandNode: Node,
  context: MaestroProgramParseContext,
): { key: 'visible' | 'notVisible'; selector: MaestroSelector; optional?: boolean } {
  const visible = parseMaestroOptionalSelector(
    entries,
    'visible',
    'extendedWaitUntil.visible',
    context,
  );
  const notVisible = parseMaestroOptionalSelector(
    entries,
    'notVisible',
    'extendedWaitUntil.notVisible',
    context,
  );
  if (visible && notVisible)
    invalidAt(
      'Maestro extendedWaitUntil cannot specify both visible and notVisible.',
      commandNode,
      context,
    );
  if (!visible && !notVisible)
    invalidAt('Maestro extendedWaitUntil requires visible or notVisible.', commandNode, context);
  return visible
    ? { key: 'visible', selector: visible.selector, optional: visible.optional }
    : { key: 'notVisible', selector: notVisible!.selector, optional: notVisible!.optional };
}
