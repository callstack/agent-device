import type { SnapshotNode } from '../kernel/snapshot.ts';
import { AppError } from '../kernel/errors.ts';
import { tryParseSelectorChain, type SelectorChain } from './selectors-parse.ts';

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
  | { kind: 'wait'; timeoutMs?: number };

type FindMatchOptions = {
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
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

export function normalizeRole(value: string): string {
  let normalized = value.trim();
  if (!normalized) return '';
  const lastSegment = normalized.split('.').pop() ?? normalized;
  normalized = lastSegment.replace(/XCUIElementType/gi, '').toLowerCase();
  return normalized;
}

export function parseFindArgs(args: string[]): {
  locator: FindLocator;
  query: string;
  action: FindAction['kind'];
  value?: string;
  timeoutMs?: number;
} {
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
  const action = actionTokens[0]?.toLowerCase();
  if (action === 'get') {
    const sub = actionTokens[1]?.toLowerCase();
    if (sub === 'text') return { locator, query, action: 'get_text' };
    if (sub === 'attrs') return { locator, query, action: 'get_attrs' };
    throw new AppError('INVALID_ARGS', 'find get only supports text or attrs');
  }
  if (action === 'wait') {
    const timeoutMs = parseTimeout(actionTokens[1]);
    return { locator, query, action: 'wait', timeoutMs: timeoutMs ?? undefined };
  }
  if (action === 'exists') return { locator, query, action: 'exists' };
  if (action === 'click') return { locator, query, action: 'click' };
  if (action === 'focus') return { locator, query, action: 'focus' };
  if (action === 'fill') {
    const value = actionTokens.slice(1).join(' ');
    return { locator, query, action: 'fill', value };
  }
  if (action === 'type') {
    const value = actionTokens.slice(1).join(' ');
    return { locator, query, action: 'type', value };
  }
  throw new AppError('INVALID_ARGS', `Unsupported find action: ${actionTokens[0]}`);
}

export function parseFindSelectorExpression(
  locator: FindLocator,
  query: string,
): SelectorChain | null {
  if (locator !== 'any') return null;
  if (!query.includes('=') && !query.includes('||')) return null;
  return tryParseSelectorChain(query);
}

function parseTimeout(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
