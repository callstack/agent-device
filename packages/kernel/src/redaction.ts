const SENSITIVE_KEY_RE =
  /(token|secret|password|authorization|cookie|api[_-]?key|access[_-]?key|private[_-]?key|user[_-]?code|device[_-]?code|refresh[_-]?credential)/i;
const SECRET_TOKEN_RE =
  /\b(?:bearer\s+[a-z0-9._-]+|adc_(?:agent|live|refresh|cli)_[a-z0-9._-]+)\b/gi;
const SENSITIVE_ASSIGNMENT_RE =
  /\b([a-z0-9_-]*(?:api[_-]?key|token|secret|password|user[_-]?code|device[_-]?code|refresh[_-]?credential)[a-z0-9_-]*)(\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi;
const URL_RE = /https?:\/\/[^\s"'<>]+/gi;
const REDACTED_STRING_MAX_LENGTH = 400;
const REDACTED_STDERR_MAX_LENGTH = 8192;
const TRUNCATION_SUFFIX = '...<truncated>';

export function redactDiagnosticData<T>(input: T): T {
  return redactValue(input, {
    ancestors: new WeakSet(),
    clones: new WeakMap(),
    circularMarks: 0,
  }) as T;
}

/** Sanitizes an untrusted structured cause before it crosses a process or client boundary. */
export function sanitizeErrorCause(cause: unknown): { message: string; code?: string } | undefined {
  if (!cause || typeof cause !== 'object') return undefined;
  const candidate = cause as { message?: unknown; code?: unknown };
  if (typeof candidate.message !== 'string' || candidate.message.length === 0) return undefined;
  return redactDiagnosticData({
    message: candidate.message,
    ...(typeof candidate.code === 'string' && candidate.code.length > 0
      ? { code: candidate.code }
      : {}),
  });
}

/**
 * `ancestors` holds only the current path, so a shared non-cyclic reference is copied, not marked.
 * An object's redacted clone never depends on the key it sits under (`keyHint` only bounds strings),
 * so `clones` reuses a finished clone instead of redacting a shared subtree once per path. A clone
 * that contains a `[Circular]` mark depends on the path it was reached by and is not reused.
 */
type RedactionTraversal = {
  ancestors: WeakSet<object>;
  clones: WeakMap<object, unknown>;
  circularMarks: number;
};

function redactValue(value: unknown, traversal: RedactionTraversal, keyHint?: string): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactString(value, keyHint);
  if (typeof value !== 'object') return value;

  if (traversal.clones.has(value)) return traversal.clones.get(value);
  if (traversal.ancestors.has(value)) {
    traversal.circularMarks += 1;
    return '[Circular]';
  }
  const marksBefore = traversal.circularMarks;
  traversal.ancestors.add(value);
  try {
    const clone = redactObject(value, traversal);
    if (traversal.circularMarks === marksBefore) traversal.clones.set(value, clone);
    return clone;
  } finally {
    traversal.ancestors.delete(value);
  }
}

function redactObject(value: object, traversal: RedactionTraversal): unknown {
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry, traversal));
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    output[key] = SENSITIVE_KEY_RE.test(key) ? '[REDACTED]' : redactValue(entry, traversal, key);
  }
  return output;
}

function redactString(value: string, keyHint?: string): string {
  const trimmed = value.trim();
  if (!trimmed) return boundRedactedString(value, keyHint);
  if (keyHint && SENSITIVE_KEY_RE.test(keyHint)) return '[REDACTED]';
  let output = redactUrls(trimmed);
  output = output.replace(SECRET_TOKEN_RE, '[REDACTED]');
  output = output.replace(
    SENSITIVE_ASSIGNMENT_RE,
    (match, key: string, separator: string, rawValue: string, offset: number, input: string) => {
      if (isSafeSetupUrlAssignment({ key, separator, rawValue, offset, input })) return match;
      if (isDocumentedTokenPlaceholder(rawValue)) return match;
      return `${key}${separator}[REDACTED]`;
    },
  );
  return boundRedactedString(output, keyHint);
}

function boundRedactedString(value: string, keyHint?: string): string {
  if (keyHint === 'stderr') {
    if (value.length <= REDACTED_STDERR_MAX_LENGTH) return value;
    const marker = `\n${TRUNCATION_SUFFIX}\n`;
    const retainedLength = REDACTED_STDERR_MAX_LENGTH - marker.length;
    const headLength = Math.ceil(retainedLength / 2);
    return `${value.slice(0, headLength)}${marker}${value.slice(-(retainedLength - headLength))}`;
  }
  if (value.length <= REDACTED_STRING_MAX_LENGTH) return value;
  return `${value.slice(0, REDACTED_STRING_MAX_LENGTH - TRUNCATION_SUFFIX.length)}${TRUNCATION_SUFFIX}`;
}

function redactUrls(value: string): string {
  return value.replace(URL_RE, (url) => redactUrl(url) ?? url);
}

function isDocumentedTokenPlaceholder(value: string): boolean {
  return /^adc_(?:agent|live|refresh|cli)_\.\.\.$/i.test(value);
}

function isSafeSetupUrlAssignment(options: {
  key: string;
  separator: string;
  rawValue: string;
  offset: number;
  input: string;
}): boolean {
  if (options.key.toLowerCase() !== 'token') return false;
  if (!options.separator.includes(':')) return false;
  try {
    const url = new URL(options.rawValue);
    if (url.pathname.replace(/\/+$/, '') !== '/api-keys') return false;
    return /(?:^|\b)(?:service\/)?api\s+$/i.test(options.input.slice(0, options.offset));
  } catch {
    return false;
  }
}

function redactUrl(value: string): string | null {
  try {
    const parsed = new URL(value);
    if (parsed.search) parsed.search = '?REDACTED';
    if (parsed.username || parsed.password) {
      parsed.username = 'REDACTED';
      parsed.password = 'REDACTED';
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

// Terminal-safe output: text the CLI writes can name values a peer or a device chose (paths, labels,
// messages), so C0, DEL and C1 characters are shown as escapes instead of reaching the terminal raw.

/** C0 except newline and tab, DEL, and C1. Newline and tab are layout; every other one is escaped. */
function isEscapedControl(code: number): boolean {
  return (code < 0x20 && code !== 0x0a && code !== 0x09) || (code >= 0x7f && code <= 0x9f);
}

/** Replaces each character `escape` matches with its `render`ing, returning the input itself when none does. */
function replaceCodes(
  text: string,
  escape: (code: number) => boolean,
  render: (code: number) => string,
): string {
  let out = '';
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (!escape(code)) continue;
    out += text.slice(start, index) + render(code);
    start = index + 1;
  }
  return start === 0 ? text : out + text.slice(start);
}

/**
 * Text with C0 (except newline and tab), DEL and C1 characters shown as `\u00NN`. That is a JSON string escape too, so
 * JSON text written through it still parses to the exact values. Text with nothing to escape is returned as is.
 */
export function escapeTerminalText(text: string): string {
  return replaceCodes(text, isEscapedControl, (code) => `\\u${code.toString(16).padStart(4, '0')}`);
}

// A display line that embeds a rejected argv value can echo a credential the caller typed into
// the wrong slot. A token whose word is past 12 characters and mixes upper and lower case with
// a digit or a symbol reads as that credential; ordinary arguments (refs, paths, ids, lowercase
// names) do not. The word is the token without punctuation attached to its edges, so a sentence
// period or quotes never make an identifier like `deviceTarget` read as a secret. A separator
// inside path characters only (letters, digits, `.`, `:`, `/`, `\`, `-`, `~`) marks a location,
// not a credential: an INVALID_ARGS message names a config file or an artifact so the reader
// can open or fix it, and the scrub keeps that text. A separator next to any other character
// is the base64 or query shape of a credential, and the word test decides.

const SECRET_LIKE_MIN_LENGTH = 12;
const TOKEN_EDGE_PUNCTUATION = /^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/g;
const PATH_TOKEN_CHARACTERS = /^[\w.:/\\~-]+$/;

/** True when `token` is long and varied enough to read as a credential rather than an argument. */
function isSecretLikeToken(token: string): boolean {
  if (/[/\\]/.test(token) && PATH_TOKEN_CHARACTERS.test(token)) return false;
  const word = token.replaceAll(TOKEN_EDGE_PUNCTUATION, '');
  if (word.length <= SECRET_LIKE_MIN_LENGTH) return false;
  return /[a-z]/.test(word) && /[A-Z]/.test(word) && /[^a-zA-Z]/.test(word);
}

/**
 * Replaces each secret-like token in a display line with `<redacted len=N>`, and keeps every
 * other token and all whitespace as is. N counts the raw token, so punctuation attached to it
 * is part of N. The output carries no control character, so it passes `escapeTerminalText`
 * unchanged and stays a valid JSON string value.
 */
export function redactSecretLikeText(text: string): string {
  return text.replaceAll(/\S+/g, (token) =>
    isSecretLikeToken(token) ? `<redacted len=${token.length}>` : token,
  );
}
