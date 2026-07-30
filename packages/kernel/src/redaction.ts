const SENSITIVE_KEY_RE =
  /(token|secret|password|authorization|cookie|api[_-]?key|access[_-]?key|private[_-]?key|user[_-]?code|device[_-]?code|refresh[_-]?credential)/i;
const SECRET_TOKEN_RE =
  /\b(?:bearer\s+[a-z0-9._-]+|adc_(?:agent|live|refresh|cli)_[a-z0-9._-]+)\b/gi;
const SENSITIVE_ASSIGNMENT_RE =
  /\b([a-z0-9_-]*(?:api[_-]?key|token|secret|password|user[_-]?code|device[_-]?code|refresh[_-]?credential)[a-z0-9_-]*)(\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi;
const URL_RE = /https?:\/\/[^\s"'<>]+/gi;

export function redactDiagnosticData<T>(input: T): T {
  return redactValue(input, new WeakSet<object>()) as T;
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
  const trimmed = value.trim();
  if (!trimmed) return value;
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
  if (output !== trimmed) return output;
  if (trimmed.length > 400) return `${trimmed.slice(0, 200)}...<truncated>`;
  return trimmed;
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
