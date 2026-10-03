import type { SnapshotNode } from '@agent-device/kernel/snapshot';
import { AppError } from '@agent-device/kernel/errors';
import { tryParseSelectorChain } from './parse.ts';

export const FIND_LOCATORS = ['any', 'text', 'label', 'value', 'role', 'id'] as const;
export type FindLocator = (typeof FIND_LOCATORS)[number];
const FIND_LOCATOR_TOKENS = [
  'text',
  'label',
  'value',
  'role',
  'id',
] as const satisfies readonly FindLocator[];

export type FindAction =
  | { kind: 'click' }
  | { kind: 'focus' }
  | { kind: 'fill'; value: string }
  | { kind: 'type'; value: string }
  | { kind: 'get_text' }
  | { kind: 'get_attrs' }
  | { kind: 'exists' }
  | { kind: 'wait'; timeoutMs?: number }
  | { kind: 'list' };

export type ReadOnlyFindAction = 'exists' | 'wait' | 'get_text' | 'get_attrs' | 'list';

/**
 * `press` and `tap` are the same action as `click` everywhere else in this CLI
 * (the interaction layer treats them as synonyms), so `find` accepts them as
 * aliases of its click action instead of rejecting the vocabulary agents
 * already use. longpress/swipe stay real exclusions — they are different
 * gestures with no find form.
 */
export function normalizeFindActionToken(token: string | undefined): string | undefined {
  const lowered = token?.toLowerCase();
  return lowered === 'press' || lowered === 'tap' ? 'click' : lowered;
}

/**
 * `find` is the one command whose observation-vs-mutation split is a
 * POSITIONAL, not the command name — so it cannot be settled statically by the
 * CLI grammar the way `snapshot`/`get`/`is` are. Both the read-only dispatch
 * (`dispatchFindReadOnlyViaRuntime`) and the mutating handler
 * (`handleFindCommands`) read this one definition, so `--record`'s dynamic
 * validation (#1271 stage 2) and the read-only routing can never disagree
 * about which sub-actions observe.
 */
export function isReadOnlyFindAction(action: FindAction['kind']): action is ReadOnlyFindAction {
  return (
    action === 'exists' ||
    action === 'wait' ||
    action === 'get_text' ||
    action === 'get_attrs' ||
    action === 'list'
  );
}

export type FindMatchOptions = {
  requireRect?: boolean;
};

type FindBestMatches = {
  matches: SnapshotNode[];
  score: number;
};

export function findBestMatchesByLocator(
  nodes: SnapshotNode[],
  locator: FindLocator,
  query: string,
  options: FindMatchOptions = {},
): FindBestMatches {
  const normalizedQuery = normalizeText(query);
  if (!normalizedQuery) return { matches: [], score: 0 };
  let bestScore = 0;
  const matches: SnapshotNode[] = [];
  for (const node of nodes) {
    if (options.requireRect && !node.rect) continue;
    const score = matchNode(node, locator, normalizedQuery);
    if (score <= 0) continue;
    if (score > bestScore) {
      bestScore = score;
      matches.length = 0;
      matches.push(node);
      continue;
    }
    if (score === bestScore) {
      matches.push(node);
    }
  }
  return { matches, score: bestScore };
}

function matchNode(node: SnapshotNode, locator: FindLocator, query: string): number {
  switch (locator) {
    case 'role':
      return matchRole(node.type, query);
    case 'label':
      return matchText(node.label, query);
    case 'value':
      return matchText(node.value, query);
    case 'id':
      return matchText(node.identifier, query);
    case 'text':
    case 'any':
    default:
      return Math.max(
        matchText(node.label, query),
        matchText(node.value, query),
        matchText(node.identifier, query),
      );
  }
}

function matchText(value: string | undefined, query: string): number {
  const normalized = normalizeText(value ?? '');
  if (!normalized) return 0;
  if (normalized === query) return 2;
  if (normalized.includes(query)) return 1;
  return 0;
}

function matchRole(value: string | undefined, query: string): number {
  const normalized = normalizeRole(value ?? '');
  if (!normalized) return 0;
  if (normalized === query) return 2;
  if (normalized.includes(query)) return 1;
  return 0;
}

export function normalizeText(value: string): string {
  return value.trim().toLowerCase().replaceAll(/\s+/g, ' ');
}

function normalizeRole(value: string): string {
  let normalized = value.trim();
  if (!normalized) return '';
  const lastSegment = normalized.split('.').pop() ?? normalized;
  normalized = lastSegment.replaceAll(/XCUIElementType/gi, '').toLowerCase();
  return normalized;
}

export type ParsedFindArgs = {
  locator: FindLocator;
  query: string;
  action: FindAction['kind'];
  value?: string;
  timeoutMs?: number;
};

/** Shared by `checkFindArgs` and `findCommand`, which validates already-parsed options. */
export const FIND_VALUE_REQUIRED_MESSAGE = 'find requires a value';

/**
 * Shared by both `Unsupported find action` throw sites (this file's raw-token
 * parser and `src/commands/interaction/selectors.ts`'s typed CLI reader) so
 * the recovery guidance cannot drift between them. `find` has no longpress/
 * swipe action of its own — the fix is to inspect matches with the read-only
 * `list` action, then dispatch the gesture on the chosen @ref as its own
 * top-level command. (#1625: the old guidance said to run bare `find`, which
 * CLICKS a unique match — inspection guidance must never point at a mutation.)
 */
export const UNSUPPORTED_FIND_ACTION_HINT =
  'find actions: click (default; press/tap are aliases), list, focus, fill, type, exists, ' +
  'wait, get text, get attrs — there is no longpress/swipe find action. Run ' +
  'find "<text>" list to inspect every match with its @ref without acting, then dispatch ' +
  'the gesture on the chosen ref, e.g. longpress @eNN.';

export type FindArgumentCheck =
  | { ok: true; parsed: ParsedFindArgs }
  | { ok: false; code: 'INVALID_ARGS'; message: string };

/**
 * `find`'s positional and flag validation, in one place for the same reason
 * {@link isReadOnlyFindAction} is: both daemon entry points (the read-only
 * `dispatchFindReadOnlyViaRuntime` fast path and the mutating `handleFindCommands`) ran
 * their own copies of these three checks with hand-repeated messages, so a rule change
 * had to be made twice to hold. The caller decides how to surface a failure — the
 * daemon returns it as a response, other surfaces may throw — so this returns the
 * refusal instead of choosing a mechanism.
 *
 * Action-token validation still comes from {@link parseFindArgs}, which throws; that is
 * unchanged and callers see it exactly as before.
 */
export function checkFindArgs(
  args: readonly string[],
  flags?: { findFirst?: boolean; findLast?: boolean },
): FindArgumentCheck {
  if (args.length === 0) {
    return { ok: false, code: 'INVALID_ARGS', message: 'find requires a locator or text' };
  }
  const parsed = parseFindArgs([...args]);
  if (!parsed.query) {
    return { ok: false, code: 'INVALID_ARGS', message: FIND_VALUE_REQUIRED_MESSAGE };
  }
  if (flags?.findFirst && flags?.findLast) {
    return {
      ok: false,
      code: 'INVALID_ARGS',
      message: 'find accepts only one of --first or --last',
    };
  }
  return { ok: true, parsed };
}

/** Single-token actions carrying no extra arguments. */
const BARE_FIND_ACTIONS = ['exists', 'list', 'click', 'focus'] as const;
type BareFindAction = (typeof BARE_FIND_ACTIONS)[number];

function isBareFindAction(action: string | undefined): action is BareFindAction {
  return BARE_FIND_ACTIONS.includes(action as BareFindAction);
}

export function parseFindArgs(args: string[]): ParsedFindArgs {
  let locator: FindLocator = 'any';
  let queryIndex = 0;
  if (FIND_LOCATOR_TOKENS.includes(args[0] as (typeof FIND_LOCATOR_TOKENS)[number])) {
    locator = args[0] as FindLocator;
    queryIndex = 1;
  }
  const query = args[queryIndex] ?? '';
  const actionTokens = args.slice(queryIndex + 1);
  if (actionTokens.length === 0) {
    return { locator, query, action: 'click' };
  }
  const action = normalizeFindActionToken(actionTokens[0]);
  if (isBareFindAction(action)) return { locator, query, action };
  if (action === 'get') {
    return { locator, query, action: parseFindGetSubAction(actionTokens[1]) };
  }
  if (action === 'wait') {
    const timeoutMs = parseTimeout(actionTokens[1]);
    return { locator, query, action: 'wait', timeoutMs: timeoutMs ?? undefined };
  }
  if (action === 'fill' || action === 'type') {
    // `undefined` when NO value token followed, `''` when an empty one did: `find <q> fill ""`
    // is the clear request (#2063) and must stay distinguishable from a forgotten argument.
    const valueTokens = actionTokens.slice(1);
    return {
      locator,
      query,
      action,
      value: valueTokens.length === 0 ? undefined : valueTokens.join(' '),
    };
  }
  throw new AppError('INVALID_ARGS', `Unsupported find action: ${actionTokens[0]}`, {
    hint: UNSUPPORTED_FIND_ACTION_HINT,
  });
}

function parseFindGetSubAction(token: string | undefined): 'get_text' | 'get_attrs' {
  const sub = token?.toLowerCase();
  if (sub === 'text') return 'get_text';
  if (sub === 'attrs') return 'get_attrs';
  throw new AppError('INVALID_ARGS', 'find get only supports text or attrs');
}

export function parseFindSelectorExpression(locator: FindLocator, query: string): string | null {
  if (locator !== 'any') return null;
  if (!query.includes('=') && !query.includes('||')) return null;
  return tryParseSelectorChain(query) ? query : null;
}

function parseTimeout(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
