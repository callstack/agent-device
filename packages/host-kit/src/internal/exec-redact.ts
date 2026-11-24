/** The placeholder that replaces every redacted value in retained output and error argv. */
const REDACTED_ARG = '[redacted]';

export function redactArgv(
  args: readonly string[],
  redactions: readonly string[] | undefined,
): string[] {
  if (!redactions?.length) return [...args];
  return args.map((arg) => (redactions.includes(arg) ? REDACTED_ARG : arg));
}

/**
 * One streaming scrubber over the caller's redactions. Every chunk joins the pending tail and the
 * whole buffer is scrubbed BEFORE the emit/hold split, so any secret already complete in the buffer
 * is replaced before its surrounding text can reach a callback; the hold (longest secret minus one)
 * keeps a still-incomplete tail occurrence pending. A secret a chunk boundary splits is still one
 * match. The close flush releases the held tail and masks a trailing fragment a cut-off stream
 * leaves — a fragment long enough to recognize never survives. Only the values the caller redacts
 * are scrubbed: the rest of the output, flag names and non-secret argv echoes included, reaches the
 * logs unchanged. `binaryStdout` capture is byte-exact by contract and is not scrubbed; do not pair
 * it with `redactions`.
 */
function streamScrubber(redactions: readonly string[]): (chunk: string, flush?: boolean) => string {
  const secrets = [...new Set(redactions)].filter((value) => value.length > 0);
  const hold = secrets.reduce((max, value) => Math.max(max, value.length - 1), 0);
  const FRAGMENT_MIN = 4;
  let pending = '';
  const scrubText = (text: string): string => {
    for (const secret of secrets) {
      if (text.includes(secret)) text = text.split(secret).join(REDACTED_ARG);
    }
    return text;
  };
  /** Masks a trailing proper prefix of a secret — the tail of an echo the stream cut mid-value. */
  const maskPartialTail = (text: string): string => {
    for (const secret of secrets) {
      if (secret.length < 2 * FRAGMENT_MIN) continue;
      const max = Math.min(text.length, secret.length - 1);
      for (let length = max; length >= FRAGMENT_MIN; length--) {
        if (text.endsWith(secret.slice(0, length))) {
          return `${text.slice(0, text.length - length)}${REDACTED_ARG}`;
        }
      }
    }
    return text;
  };
  return (chunk, flush = false) => {
    const text = scrubText(pending + chunk);
    pending = '';
    if (!flush) {
      if (text.length > hold) {
        pending = text.slice(-hold);
        return text.slice(0, -hold);
      }
      pending = text;
      return '';
    }
    return maskPartialTail(text);
  };
}

/**
 * The redaction face one redacted command uses: the raw argv stays at the spawn boundary, the
 * chunk callbacks and the retained stdout/stderr receive scrubbed text, and `argv` is the sanitized
 * copy every error this module builds carries. Split matches stay single matches, and a value the
 * caller redacts beyond the argv — an echoed flag name — scrubs from the streams too.
 */
export function createArgRedactor(
  args: readonly string[],
  redactions: readonly string[] | undefined,
): {
  argv: readonly string[];
  scrubOut(chunk: string): string;
  scrubErr(chunk: string): string;
  flushOut(): string;
  flushErr(): string;
} {
  if (!redactions?.length) {
    const pass = (chunk: string) => chunk;
    return {
      argv: [...args],
      scrubOut: pass,
      scrubErr: pass,
      flushOut: () => '',
      flushErr: () => '',
    };
  }
  const scrubOut = streamScrubber(redactions);
  const scrubErr = streamScrubber(redactions);
  return {
    argv: redactArgv(args, redactions),
    scrubOut: (chunk) => scrubOut(chunk),
    scrubErr: (chunk) => scrubErr(chunk),
    flushOut: () => scrubOut('', true),
    flushErr: () => scrubErr('', true),
  };
}
