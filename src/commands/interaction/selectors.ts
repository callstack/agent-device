import { PUBLIC_COMMANDS } from '../../command-catalog.ts';
import type { FindOptions, IsOptions } from '@agent-device/contracts/client';
import type { CliFlags } from '@agent-device/contracts/command';
import { AppError } from '@agent-device/kernel/errors';
import {
  checkIsPredicate,
  normalizeFindActionToken,
  normalizeIsPositionals,
  UNSUPPORTED_FIND_ACTION_HINT,
} from '@agent-device/selectors';
import {
  direct,
  optionalCliNumber,
  optionalNumber,
  observationRecordInputFromFlags,
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
    case 'list':
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
    ...observationRecordInputFromFlags(flags),
    first: flags.findFirst,
    last: flags.findLast,
  };
  const locator = readFindLocator(positionals[0]);
  const hasExplicitLocator = locator !== undefined;
  const query = hasExplicitLocator ? positionals[1] : positionals[0];
  const actionOffset = hasExplicitLocator ? 2 : 1;
  const action = normalizeFindActionToken(positionals[actionOffset]);
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
    // An empty value positional is the clear request (#2063); only a MISSING one is refused,
    // here, so `value` stays present on the typed options.
    const valuePositionals = positionals.slice(actionOffset + 1);
    if (valuePositionals.length === 0) {
      throw new AppError(
        'INVALID_ARGS',
        action === 'fill'
          ? 'find fill requires text (use "" to clear the field)'
          : 'find type requires text',
      );
    }
    return {
      ...base,
      locator,
      query: readRequiredQuery(query),
      action,
      value: valuePositionals.join(' '),
    };
  }
  if (action === 'click' || action === 'focus' || action === 'exists' || action === 'list') {
    return { ...base, locator, query: readRequiredQuery(query), action };
  }
  throw new AppError('INVALID_ARGS', `Unsupported find action: ${positionals[actionOffset]}`, {
    hint: UNSUPPORTED_FIND_ACTION_HINT,
  });
}

function readIsOptionsFromPositionals(positionals: string[], flags: CliFlags): IsOptions {
  const base = {
    ...selectorSnapshotOptionsFromFlags(flags),
    ...selectionOptionsFromFlags(flags),
    ...observationRecordInputFromFlags(flags),
  };
  const normalized = normalizeIsPositionals(positionals);
  const admitted = checkIsPredicate(normalized[0] ?? '');
  if (!admitted.ok) {
    throw new AppError(admitted.code, admitted.message, { hint: admitted.hint });
  }
  // The admitted predicate is lower-cased, matching what the daemon accepts. The inlined
  // check this replaced compared the raw token, so the CLI used to be stricter than the
  // executor it hands the command to.
  const predicate = admitted.predicate;
  if (predicate === 'absent') {
    const refusedOption = absenceCaptureOptionRefusal(base);
    if (refusedOption) {
      throw absenceCaptureOptionError(refusedOption);
    }
  }
  const split = splitRequiredSelector(normalized.slice(1), {
    preferTrailingValue: predicate === 'text',
  });
  if (predicate === 'text') {
    return { ...base, predicate, selector: split.selectorExpression, value: split.rest.join(' ') };
  }
  return { ...base, predicate, selector: split.selectorExpression };
}

type AbsenceCaptureOption = 'depth' | 'scope';

function absenceCaptureOptionRefusal(options: {
  depth?: number;
  scope?: string;
}): AbsenceCaptureOption | undefined {
  if (options.scope !== undefined) return 'scope';
  if (options.depth !== undefined) return 'depth';
  return undefined;
}

function absenceCaptureOptionError(option: AbsenceCaptureOption): AppError {
  const message =
    option === 'scope'
      ? 'is absent does not support --scope; it requires an unscoped capture'
      : 'is absent does not support --depth; it requires a full-depth capture';
  return new AppError('INVALID_ARGS', message, {
    command: 'is',
    predicate: 'absent',
    rejectedOption: option,
  });
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
