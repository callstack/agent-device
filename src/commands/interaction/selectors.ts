import { PUBLIC_COMMANDS } from '../../command-catalog.ts';
import type { FindOptions, IsOptions } from '../../client/client-types.ts';
import type { CliFlags } from '../cli-grammar/flag-types.ts';
import { AppError } from '../../kernel/errors.ts';
import {
  IS_PREDICATE_REQUIRED_MESSAGE,
  IS_PREDICATE_USAGE_HINT,
  normalizeIsPositionals,
} from '../../selectors/predicates.ts';
import {
  direct,
  optionalCliNumber,
  optionalNumber,
  recordControlInputFromFlags,
  request,
  selectionOptionsFromFlags,
  selectorSnapshotOptionsFromFlags,
  splitRequiredSelector,
} from '../cli-grammar/common.ts';
import type { CliReader, DaemonWriter } from '../cli-grammar/types.ts';

export const selectorCliReaders = {
  find: (positionals, flags) => readFindOptionsFromPositionals(positionals, flags),
  is: (positionals, flags) => readIsOptionsFromPositionals(positionals, flags),
} satisfies Record<string, CliReader>;

export const selectorDaemonWriters = {
  is: direct(PUBLIC_COMMANDS.is, (input) => isPositionals(input as IsOptions)),
  find: (input) =>
    request(PUBLIC_COMMANDS.find, findPositionals(input as FindOptions), {
      ...input,
      findFirst: input.first,
      findLast: input.last,
    }),
} satisfies Record<string, DaemonWriter>;

function isPositionals(input: IsOptions): string[] {
  return [input.predicate, input.selector, ...(input.predicate === 'text' ? [input.value] : [])];
}

// fallow-ignore-next-line complexity
function findPositionals(input: FindOptions): string[] {
  const args =
    input.locator && input.locator !== 'any' ? [input.locator, input.query] : [input.query];
  switch (input.action) {
    case undefined:
    case 'click':
    case 'focus':
    case 'exists':
      return input.action ? [...args, input.action] : args;
    case 'getText':
      return [...args, 'get', 'text'];
    case 'getAttrs':
      return [...args, 'get', 'attrs'];
    case 'wait':
      return [...args, 'wait', ...optionalNumber(input.timeoutMs)];
    case 'fill':
    case 'type':
      return [...args, input.action, input.value];
  }
}

// fallow-ignore-next-line complexity
function readFindOptionsFromPositionals(positionals: string[], flags: CliFlags): FindOptions {
  const base = {
    ...findSnapshotOptionsFromFlags(flags),
    ...selectionOptionsFromFlags(flags),
    ...recordControlInputFromFlags(flags),
    first: flags.findFirst,
    last: flags.findLast,
  };
  const locator = readFindLocator(positionals[0]);
  const hasExplicitLocator = locator !== undefined;
  const query = hasExplicitLocator ? positionals[1] : positionals[0];
  const actionOffset = hasExplicitLocator ? 2 : 1;
  const action = positionals[actionOffset];
  if (action === undefined) return { ...base, locator, query: readRequiredQuery(query) };
  if (action === 'get') {
    const subcommand = positionals[actionOffset + 1];
    if (subcommand === 'text') {
      return { ...base, locator, query: readRequiredQuery(query), action: 'getText' };
    }
    if (subcommand === 'attrs') {
      return { ...base, locator, query: readRequiredQuery(query), action: 'getAttrs' };
    }
    throw new AppError('INVALID_ARGS', 'find get only supports text or attrs');
  }
  if (action === 'wait') {
    return {
      ...base,
      locator,
      query: readRequiredQuery(query),
      action: 'wait',
      timeoutMs: optionalCliNumber(positionals[actionOffset + 1]),
    };
  }
  if (action === 'fill' || action === 'type') {
    return {
      ...base,
      locator,
      query: readRequiredQuery(query),
      action,
      value: positionals.slice(actionOffset + 1).join(' '),
    };
  }
  if (action === 'click' || action === 'focus' || action === 'exists') {
    return { ...base, locator, query: readRequiredQuery(query), action };
  }
  throw new AppError('INVALID_ARGS', `Unsupported find action: ${action}`);
}

function readIsOptionsFromPositionals(positionals: string[], flags: CliFlags): IsOptions {
  const base = {
    ...selectorSnapshotOptionsFromFlags(flags),
    ...selectionOptionsFromFlags(flags),
    ...recordControlInputFromFlags(flags),
  };
  const normalized = normalizeIsPositionals(positionals);
  const predicate = normalized[0];
  if (
    predicate !== 'text' &&
    predicate !== 'visible' &&
    predicate !== 'hidden' &&
    predicate !== 'exists' &&
    predicate !== 'editable' &&
    predicate !== 'selected' &&
    predicate !== 'focused'
  ) {
    throw new AppError('INVALID_ARGS', IS_PREDICATE_REQUIRED_MESSAGE, {
      hint: IS_PREDICATE_USAGE_HINT,
    });
  }
  const split = splitRequiredSelector(normalized.slice(1), {
    preferTrailingValue: predicate === 'text',
  });
  if (predicate === 'text') {
    return { ...base, predicate, selector: split.selectorExpression, value: split.rest.join(' ') };
  }
  return { ...base, predicate, selector: split.selectorExpression };
}

function readFindLocator(value: string | undefined): FindOptions['locator'] | undefined {
  if (
    value === 'text' ||
    value === 'label' ||
    value === 'value' ||
    value === 'role' ||
    value === 'id'
  ) {
    return value;
  }
  return undefined;
}

function findSnapshotOptionsFromFlags(flags: CliFlags): {
  depth?: number;
  raw?: boolean;
} {
  return {
    depth: flags.snapshotDepth,
    raw: flags.snapshotRaw,
  };
}

function readRequiredQuery(value: string | undefined): string {
  if (value === undefined || value === '')
    throw new AppError('INVALID_ARGS', 'find requires query');
  return value;
}
