import { AppError } from '../kernel/errors.ts';

export type SelectorKey =
  | 'id'
  | 'role'
  | 'text'
  | 'label'
  | 'value'
  | 'appname'
  | 'windowtitle'
  | 'visible'
  | 'hidden'
  | 'editable'
  | 'selected'
  | 'focused'
  | 'enabled'
  | 'hittable';

export type SelectorTerm = {
  key: SelectorKey;
  value: string | boolean;
};

export type Selector = {
  raw: string;
  terms: SelectorTerm[];
};

export type SelectorChain = {
  raw: string;
  selectors: Selector[];
};

const TEXT_KEYS = new Set<SelectorKey>([
  'id',
  'role',
  'text',
  'label',
  'value',
  'appname',
  'windowtitle',
]);
const BOOLEAN_KEYS = new Set<SelectorKey>([
  'visible',
  'hidden',
  'editable',
  'selected',
  'focused',
  'enabled',
  'hittable',
]);
const ALL_KEYS = new Set<SelectorKey>([...TEXT_KEYS, ...BOOLEAN_KEYS]);

/** Selector key names accepted on the left of `key=value`, for error messages. */
export const SELECTOR_KEY_NAMES: readonly SelectorKey[] = [...ALL_KEYS];

// Role/element-type words that show up as accessibility roles, not selector keys (e.g. the
// `button` in `button="Push Article"`). Superset of the ROLE_LABELS vocabulary in
// src/snapshot/snapshot-lines.ts (plus a few common role words like list/tab/alert/dialog/header,
// minus valid selector keys such as `text`, which ALL_KEYS short-circuits before this set is
// consulted), kept as a local copy to avoid a utils/ -> snapshot/ layering dependency
// (scripts/layering/check.ts). Drifts silently if ROLE_LABELS grows; that's fine here since this
// is only used to sharpen a hint, not to validate anything.
const ROLE_HINT_WORDS = new Set([
  'button',
  'imagebutton',
  'link',
  'cell',
  'statictext',
  'checkedtextview',
  'textfield',
  'textbox',
  'edittext',
  'textarea',
  'switch',
  'slider',
  'image',
  'imageview',
  'webview',
  'framelayout',
  'linearlayout',
  'relativelayout',
  'constraintlayout',
  'viewgroup',
  'view',
  'listview',
  'recyclerview',
  'collectionview',
  'list',
  'searchfield',
  'segmentedcontrol',
  'group',
  'window',
  'checkbox',
  'radio',
  'menuitem',
  'toolbar',
  'scrollarea',
  'scrollview',
  'nestedscrollview',
  'table',
  'application',
  'navigationbar',
  'tabbar',
  'tab',
  'alert',
  'dialog',
  'header',
]);

/** Whether `key` looks like an accessibility role word rather than a selector key. */
export function isRoleHintWord(key: string): boolean {
  return ROLE_HINT_WORDS.has(key.trim().toLowerCase());
}

const SIMPLE_ESCAPE_REPLACEMENTS = new Map<string, string>([
  ['"', '"'],
  ["'", "'"],
  ['\\', '\\'],
  ['/', '/'],
  ['b', '\b'],
  ['f', '\f'],
  ['n', '\n'],
  ['r', '\r'],
  ['t', '\t'],
]);

export function parseSelectorChain(expression: string): SelectorChain {
  const raw = expression.trim();
  if (!raw) {
    throw new AppError('INVALID_ARGS', 'Selector expression cannot be empty');
  }
  const segments = splitByFallback(raw);
  if (segments.length === 0) {
    throw new AppError('INVALID_ARGS', 'Selector expression cannot be empty');
  }
  return {
    raw,
    selectors: segments.map((segment) => parseSelector(segment)),
  };
}

export function tryParseSelectorChain(expression: string): SelectorChain | null {
  try {
    return parseSelectorChain(expression);
  } catch {
    return null;
  }
}

export function isSelectorToken(token: string): boolean {
  const trimmed = token.trim();
  if (!trimmed) return false;
  if (trimmed === '||') return true;
  const equalsIdx = trimmed.indexOf('=');
  if (equalsIdx !== -1) {
    const key = trimmed.slice(0, equalsIdx).trim().toLowerCase() as SelectorKey;
    return ALL_KEYS.has(key);
  }
  return ALL_KEYS.has(trimmed.toLowerCase() as SelectorKey);
}

/**
 * Detects a `key=value` token whose key is not a recognized selector key, e.g.
 * `button="Push Article"`. Returns the lowercased key and unquoted value so callers can build a
 * targeted "did you mean role=/label=" hint instead of treating the whole token as free text.
 * Returns null for tokens without an `=`, an empty key, an empty or whitespace-only value, or a
 * recognized key.
 */
export function detectUnknownSelectorKeyToken(
  token: string,
): { key: string; value: string } | null {
  const trimmed = token.trim();
  const equalsIdx = trimmed.indexOf('=');
  if (equalsIdx === -1) return null;
  const key = trimmed.slice(0, equalsIdx).trim().toLowerCase();
  if (!key) return null;
  if (ALL_KEYS.has(key as SelectorKey)) return null;
  const valueRaw = trimmed.slice(equalsIdx + 1).trim();
  if (!valueRaw) return null;
  const value = unquote(valueRaw).trim();
  if (!value) return null;
  return { key, value };
}

export function splitSelectorFromArgs(
  args: string[],
  options: { preferTrailingValue?: boolean } = {},
): { selectorExpression: string; rest: string[] } | null {
  if (args.length === 0) return null;
  const preferTrailingValue = options.preferTrailingValue ?? false;
  let i = 0;
  const boundaries: number[] = [];
  while (i < args.length) {
    const token = args[i];
    if (token === undefined || !isSelectorToken(token)) break;
    i += 1;
    const candidate = args.slice(0, i).join(' ').trim();
    if (!candidate) continue;
    if (tryParseSelectorChain(candidate)) {
      boundaries.push(i);
    }
  }
  if (boundaries.length === 0) return null;
  const lastBoundary = boundaries.at(-1);
  if (lastBoundary === undefined) return null;
  let boundary = lastBoundary;
  if (preferTrailingValue) {
    for (let i = boundaries.length - 1; i >= 0; i -= 1) {
      const candidateBoundary = boundaries[i];
      if (candidateBoundary === undefined) continue;
      if (candidateBoundary < args.length) {
        boundary = candidateBoundary;
        break;
      }
    }
  }
  const selectorExpression = args.slice(0, boundary).join(' ').trim();
  if (!selectorExpression) return null;
  return {
    selectorExpression,
    rest: args.slice(boundary),
  };
}

function parseSelector(segment: string): Selector {
  const raw = segment.trim();
  if (!raw) throw new AppError('INVALID_ARGS', 'Selector segment cannot be empty');
  const tokens = tokenize(raw);
  if (tokens.length === 0) {
    throw new AppError('INVALID_ARGS', `Invalid selector segment: ${segment}`);
  }
  return { raw, terms: tokens.map(parseTerm) };
}

function parseTerm(token: string): SelectorTerm {
  const normalized = token.trim();
  if (!normalized) {
    throw new AppError('INVALID_ARGS', 'Empty selector term');
  }
  const equalsIdx = normalized.indexOf('=');
  if (equalsIdx === -1) {
    const key = normalized.toLowerCase() as SelectorKey;
    if (!BOOLEAN_KEYS.has(key)) {
      throw new AppError('INVALID_ARGS', `Invalid selector term "${token}", expected key=value`);
    }
    return { key, value: true };
  }
  const key = normalized.slice(0, equalsIdx).trim().toLowerCase() as SelectorKey;
  const valueRaw = normalized.slice(equalsIdx + 1).trim();
  if (!ALL_KEYS.has(key)) {
    throw new AppError('INVALID_ARGS', `Unknown selector key: ${key}`);
  }
  if (!valueRaw) {
    throw new AppError('INVALID_ARGS', `Missing selector value for key: ${key}`);
  }
  if (BOOLEAN_KEYS.has(key)) {
    const value = parseBoolean(valueRaw);
    if (value === null) {
      throw new AppError('INVALID_ARGS', `Invalid boolean value for ${key}: ${valueRaw}`);
    }
    return { key, value };
  }
  return { key, value: unquote(valueRaw) };
}

function splitByFallback(expression: string): string[] {
  const segments: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < expression.length; i += 1) {
    const ch = expression[i];
    if ((ch === '"' || ch === "'") && !isEscapedQuote(expression, i)) {
      quote = updateQuoteState(quote, ch);
      current += ch;
      continue;
    }
    if (!quote && ch === '|' && expression[i + 1] === '|') {
      const segment = current.trim();
      if (!segment) {
        throw new AppError('INVALID_ARGS', `Invalid selector fallback expression: ${expression}`);
      }
      segments.push(segment);
      current = '';
      i += 1;
      continue;
    }
    current += ch;
  }
  const finalSegment = current.trim();
  if (!finalSegment) {
    throw new AppError('INVALID_ARGS', `Invalid selector fallback expression: ${expression}`);
  }
  segments.push(finalSegment);
  return segments;
}

function tokenize(segment: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment.charAt(i);
    if ((ch === '"' || ch === "'") && !isEscapedQuote(segment, i)) {
      quote = updateQuoteState(quote, ch);
      current += ch;
      continue;
    }
    if (!quote && /\s/.test(ch)) {
      if (current.trim()) tokens.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (quote) {
    throw new AppError('INVALID_ARGS', `Unclosed quote in selector: ${segment}`);
  }
  if (current.trim()) tokens.push(current.trim());
  return tokens;
}

function updateQuoteState(currentQuote: '"' | "'" | null, ch: '"' | "'"): '"' | "'" | null {
  if (!currentQuote) return ch;
  return currentQuote === ch ? null : currentQuote;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return decodeQuotedSelectorValue(trimmed.slice(1, -1));
  }
  return trimmed;
}

// Keep this manual so single-quoted selectors work and malformed hand-written escapes stay literal.
function decodeQuotedSelectorValue(value: string): string {
  let decoded = '';
  let cursor = 0;
  while (cursor < value.length) {
    const char = value.charAt(cursor);
    if (char !== '\\') {
      decoded += char;
      cursor += 1;
      continue;
    }
    const escaped = value.charAt(cursor + 1);
    if (!escaped) {
      decoded += char;
      cursor += 1;
      continue;
    }
    const replacement = decodeSimpleEscape(escaped);
    if (replacement !== null) {
      decoded += replacement;
      cursor += 2;
      continue;
    }
    if (escaped === 'u') {
      const hex = value.slice(cursor + 2, cursor + 6);
      if (/^[0-9a-fA-F]{4}$/.test(hex)) {
        // JSON-style \u escapes are code units; adjacent surrogate units compose in JS strings.
        decoded += String.fromCharCode(Number.parseInt(hex, 16));
        cursor += 6;
        continue;
      }
    }
    decoded += char;
    cursor += 1;
  }
  return decoded;
}

function decodeSimpleEscape(escaped: string): string | null {
  return SIMPLE_ESCAPE_REPLACEMENTS.get(escaped) ?? null;
}

function parseBoolean(value: string): boolean | null {
  const normalized = unquote(value).toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  return null;
}

function isEscapedQuote(source: string, index: number): boolean {
  let backslashCount = 0;
  for (let i = index - 1; i >= 0 && source[i] === '\\'; i -= 1) {
    backslashCount += 1;
  }
  return backslashCount % 2 === 1;
}
