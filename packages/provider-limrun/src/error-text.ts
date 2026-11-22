/**
 * Reads an instance's own text into something this process may publish.
 *
 * The caller authenticates to the instance with a token that the instance's text can echo, and core
 * redacts only what it recognizes by pattern: an unlabeled echo of the bare token survives. So every
 * value the caller sent to this endpoint is removed first. Core still bounds and pattern-redacts what
 * this returns, as it does for every error detail. The status and typed reason are published as details
 * next to this text, so the text carries no other duty.
 */
export function safeInstanceErrorText(
  text: string,
  sentValues: Iterable<string | undefined>,
): string {
  let output = text;
  for (const secret of instanceSecrets(sentValues)) {
    output = output.split(secret).join(REPLACEMENT);
  }
  return output;
}

const REPLACEMENT = '[REDACTED]';

/** One whitespace-separated header value's parts: a scheme name carries no secret on its own. */
const CREDENTIAL_SCHEMES = new Set(['bearer', 'basic', 'token', 'digest']);

/**
 * Every secret value the caller sent: each header value whole, and its credential on its own, which is
 * the form an instance echoes. A short credential is still a credential — the reader of an attached
 * instance's token accepts any nonempty value — so no candidate is skipped for being brief.
 */
function instanceSecrets(sentValues: Iterable<string | undefined>): string[] {
  const secrets = new Set<string>();
  for (const value of sentValues) {
    const trimmed = value?.trim();
    if (!trimmed) continue;
    secrets.add(trimmed);
    const [scheme = '', ...rest] = trimmed.split(/\s+/);
    const credential = rest.join(' ').trim();
    if (credential.length > 0 && CREDENTIAL_SCHEMES.has(scheme.toLowerCase())) {
      secrets.add(credential);
    }
  }
  // The longest first, so a header value is replaced before its own shorter credential is.
  return [...secrets].sort((left, right) => right.length - left.length);
}

/**
 * A scrubber for one authenticated stream, safe across chunk boundaries.
 *
 * The credential is not atomic in the stream: a chunk can end in the first half of a token and the next
 * can carry the rest, and no chunk on its own then holds anything to match. So each push scrubs what it
 * holds and releases all of it except the tail that could still be the beginning of a credential — the
 * longest ending of it that is a proper prefix of one. `flush()` releases what a finished stream holds
 * back. The replacement marker itself may straddle two answers; concatenated, they read as one marker.
 */
export function createInstanceStreamScrubber(sentValues: Iterable<string | undefined>): {
  /** Scrubs what the stream holds plus `chunk`, and answers with the text now safe to publish. */
  push(chunk: string): string;
  /** Scrubs and answers with whatever the stream still holds back at its end. */
  flush(): string;
} {
  const secrets = instanceSecrets(sentValues);
  let pending = '';
  return {
    push(chunk) {
      pending = safeInstanceErrorText(pending + chunk, secrets);
      const releaseEnd = pending.length - longestCredentialPrefixAtTheEnd(pending, secrets);
      const released = pending.slice(0, releaseEnd);
      pending = pending.slice(releaseEnd);
      return released;
    },
    flush() {
      const released = safeInstanceErrorText(pending, secrets);
      pending = '';
      return released;
    },
  };
}

/**
 * How much of `text`'s end could still be the beginning of a credential: the longest ending of it that is
 * a proper prefix of one. Only that much has to wait for the next chunk, since a credential reaching
 * across the released boundary would have to start inside what is held back.
 */
function longestCredentialPrefixAtTheEnd(text: string, secrets: readonly string[]): number {
  const longest = longestSecretLength(secrets);
  for (let length = Math.min(text.length, longest - 1); length > 0; length--) {
    const ending = text.slice(-length);
    if (secrets.some((secret) => secret.length > length && secret.startsWith(ending)))
      return length;
  }
  return 0;
}

function longestSecretLength(secrets: readonly string[]): number {
  return secrets.reduce((longest, secret) => Math.max(longest, secret.length), 0);
}

/** How much of the peer's own classification this process publishes. */
const MAX_PUBLISHED_REASON_LENGTH = 200;

/**
 * Reads the account API's reason for ending an instance into text this process may publish.
 *
 * The field is Limrun's own classification and its length is not bounded here. It is published in the
 * message and the details of the error that ends a lease, and a message is not bound the way a detail
 * is, so a reason carrying a newline would put a second line into a log and one carrying the account
 * key would hand it to every reader of the lease. So it is shortened to one line and scrubbed like any
 * other peer text; an empty answer is still answered with `Unknown`.
 *
 * The text is scrubbed before it is shortened. A credential the peer echoed can sit across the cut, and
 * shortening first would publish the characters it holds up to the cut: no longer the whole credential,
 * so nothing recognizes or removes them. The cut can also fall inside the marker that stands for a
 * credential, and a published line never ends with half of one.
 */
export function safeTerminationReason(
  reason: string | undefined,
  sentValues: Iterable<string | undefined>,
): string {
  const trimmed = reason?.trim();
  if (!trimmed) return 'Unknown';
  const oneLine = safeInstanceErrorText(trimmed.replaceAll(/\s+/g, ' '), sentValues);
  if (oneLine.length <= MAX_PUBLISHED_REASON_LENGTH) return oneLine;
  return `${withoutTrailingPartialMarker(oneLine.slice(0, MAX_PUBLISHED_REASON_LENGTH))}…`;
}

/** Drops the tail of `text` that is the beginning of a replacement marker but not a whole one. */
function withoutTrailingPartialMarker(text: string): string {
  for (let length = REPLACEMENT.length - 1; length > 0; length--) {
    if (text.endsWith(REPLACEMENT.slice(0, length))) return text.slice(0, -length);
  }
  return text;
}
