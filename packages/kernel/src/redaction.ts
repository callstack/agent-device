const SENSITIVE_KEY_RE =
  /(token|secret|password|authorization|cookie|api[_-]?key|access[_-]?key|private[_-]?key|user[_-]?code|device[_-]?code|refresh[_-]?credential)/i;
const SECRET_TOKEN_RE =
  /\b(?:bearer\s+[a-z0-9._-]+|adc_(?:agent|live|refresh|cli)_[a-z0-9._-]+)\b/gi;
const SENSITIVE_ASSIGNMENT_RE =
  /\b([a-z0-9_-]*(?:api[_-]?key|token|secret|password|user[_-]?code|device[_-]?code|refresh[_-]?credential)[a-z0-9_-]*)(\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi;
/**
 * A JSON secret assignment, where the key is quoted: `"apiKey":"sk-live"`. The value keeps its
 * quotes so the payload stays valid JSON. It runs first, so the whitespace-tolerant rule above
 * never meets the quoted form, whose key `token` sits one character after a quote the `\b` of the
 * earlier rule cannot match the same way.
 */
const SENSITIVE_JSON_ASSIGNMENT_RE =
  /(["'][a-z0-9_-]*(?:api[_-]?key|token|secret|password|user[_-]?code|device[_-]?code|refresh[_-]?credential)[a-z0-9_-]*["']\s*[=:]\s*)("(?:[^"\\]|\\.)*"|'[^']*')/gi;
const URL_RE = /https?:\/\/[^\s"'<>]+/gi;
const REDACTED_STRING_MAX_LENGTH = 400;
const REDACTED_STDERR_MAX_LENGTH = 8192;
const TRUNCATION_SUFFIX = '...<truncated>';

export function redactDiagnosticData<T>(input: T): T {
  return redactValue(input, new WeakSet<object>()) as T;
}

/**
 * Redacts one captured network payload (a body) with the same secret rules diagnostics use, then
 * bounds it to `maxLength` characters. Captured HTTP payloads carry their own agreed budget, so
 * this bound replaces the shorter diagnostic string bound.
 */
export function redactNetworkPayload(value: string, maxLength: number): string {
  const redacted = maskSecrets(value);
  if (redacted.length <= maxLength) return redacted;
  // The truncation marker counts against the budget, like the diagnostic bound.
  const kept = Math.max(0, maxLength - TRUNCATION_SUFFIX.length);
  return `${redacted.slice(0, kept)}${TRUNCATION_SUFFIX}`;
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

function redactValue(value: unknown, seen: WeakSet<object>, keyHint?: string): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactString(value, keyHint);
  if (typeof value !== 'object') return value;

  if (seen.has(value as object)) return '[Circular]';
  seen.add(value as object);

  if (Array.isArray(value)) {
    return value.map((entry) => redactValue(entry, seen));
  }

  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEY_RE.test(key)) {
      output[key] = '[REDACTED]';
      continue;
    }
    output[key] = redactValue(entry, seen, key);
  }
  return output;
}

function redactString(value: string, keyHint?: string): string {
  return boundRedactedString(maskSecrets(value, keyHint), keyHint);
}

/** Applies the secret-masking rules without any length bound; callers set their own budget. */
function maskSecrets(value: string, keyHint?: string): string {
  const trimmed = value.trim();
  if (!trimmed) return value;
  if (keyHint && SENSITIVE_KEY_RE.test(keyHint)) return '[REDACTED]';
  let output = redactUrls(trimmed);
  output = output.replace(SECRET_TOKEN_RE, '[REDACTED]');
  output = output.replace(
    SENSITIVE_JSON_ASSIGNMENT_RE,
    (match, assignment: string, rawValue: string) => {
      const quote = rawValue[0]!;
      const inner = rawValue.slice(1, -1);
      if (isDocumentedTokenPlaceholder(inner)) return match;
      return `${assignment}${quote}[REDACTED]${quote}`;
    },
  );
  output = output.replace(
    SENSITIVE_ASSIGNMENT_RE,
    (match, key: string, separator: string, rawValue: string, offset: number, input: string) => {
      if (isSafeSetupUrlAssignment({ key, separator, rawValue, offset, input })) return match;
      if (isDocumentedTokenPlaceholder(rawValue)) return match;
      return `${key}${separator}[REDACTED]`;
    },
  );
  return output;
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
