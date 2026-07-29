const SECRET_KEY_PATTERN = /(?:authorization|cookie|token|secret|password|passwd|api[-_]?key)/i;
const JWT_LIKE_PATTERN = /\b[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g;

export type RedactionResult = {
  value: string;
  redacted: boolean;
};

export function redactNetworkLogText(text: string): RedactionResult {
  let redacted = false;
  let next = text;
  next = next.replaceAll(
    /(authorization|token|secret|password|passwd|api[-_]?key)=([^&\s]+)/gi,
    (_match, key) => {
      redacted = true;
      return `${String(key)}=[REDACTED]`;
    },
  );
  next = next.replaceAll(
    /("(?:authorization|cookie|token|secret|password|passwd|api[-_]?key)"\s*:\s*")([^"]*)(")/gi,
    (_match, prefix, _value, suffix) => {
      redacted = true;
      return `${String(prefix)}[REDACTED]${String(suffix)}`;
    },
  );
  next = next.replaceAll(/\b(Bearer\s+)([^\s",;]+)/gi, (_match, prefix) => {
    redacted = true;
    return `${String(prefix)}[REDACTED]`;
  });
  next = next.replaceAll(
    /((?:authorization|cookie|token|secret|password|passwd|api[-_]?key)\s*[:=]\s*)([^\s,;&]+)/gi,
    (_match, prefix) => {
      redacted = true;
      return `${String(prefix)}[REDACTED]`;
    },
  );
  next = next.replaceAll(JWT_LIKE_PATTERN, () => {
    redacted = true;
    return '[REDACTED]';
  });
  next = redactUrlLikeValues(next, () => {
    redacted = true;
  });
  return { value: next, redacted };
}

export function redactNetworkUrl(url: string): RedactionResult | undefined {
  try {
    const parsed = new URL(url);
    let redacted = redactUrlSearchParams(parsed);
    if (parsed.username || parsed.password) {
      parsed.username = 'REDACTED';
      parsed.password = 'REDACTED';
      redacted = true;
    }
    return { value: parsed.toString(), redacted };
  } catch {
    return undefined;
  }
}

function redactUrlLikeValues(value: string, markRedacted: () => void): string {
  if (!/(https?:\/\/|token|secret|password|authorization|cookie|api[-_]?key)/i.test(value)) {
    return value;
  }
  return value.replaceAll(/https?:\/\/[^\s"'<>)]+/gi, (candidate) => {
    const result = redactNetworkUrl(candidate);
    if (!result) return candidate;
    if (result.redacted) markRedacted();
    return result.value;
  });
}

function redactUrlSearchParams(parsed: URL): boolean {
  let redacted = false;
  for (const key of Array.from(parsed.searchParams.keys())) {
    if (SECRET_KEY_PATTERN.test(key)) {
      // URLSearchParams intentionally percent-encodes the marker in the final URL.
      parsed.searchParams.set(key, '[REDACTED]');
      redacted = true;
    }
  }
  return redacted;
}
