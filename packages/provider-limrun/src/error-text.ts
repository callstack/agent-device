/** Below this length a word of a credential header is a scheme name or a common word, not a secret. */
const MIN_SECRET_LENGTH = 8;

/**
 * Reads an instance's own error text into a diagnostic this process may publish.
 *
 * The caller authenticates to the instance with a token that the instance's error body can echo, and
 * core redacts only what it recognizes by pattern: an unlabeled body that repeats the bare token
 * survives. So every value the caller sent to this endpoint is removed first. Core still bounds and
 * pattern-redacts what this returns, as it does for every error detail. The status and typed reason
 * are published as details next to this text, so the text carries no other duty.
 */
export function safeInstanceErrorText(
  text: string,
  sentValues: Iterable<string | undefined>,
): string {
  let output = text;
  for (const value of sentValues) {
    if (!value) continue;
    for (const secret of secretParts(value)) {
      output = output.split(secret).join('[REDACTED]');
    }
  }
  return output;
}

/** The secret values one header value carries: itself, and each of its long whitespace parts. */
function secretParts(value: string): string[] {
  const parts = new Set<string>([value.trim()].filter(isSecretLength));
  for (const part of value.split(/\s+/)) {
    if (isSecretLength(part)) parts.add(part);
  }
  return [...parts];
}

function isSecretLength(value: string): boolean {
  return value.length >= MIN_SECRET_LENGTH;
}
