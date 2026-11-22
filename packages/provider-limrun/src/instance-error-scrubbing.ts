import { AppError, type ReasonTable } from '@agent-device/kernel/errors';
import { safeInstanceErrorText } from './error-text.ts';
import { LIMRUN_INSTANCE_CLIENT_LOGGING } from './client-options.ts';

export async function connectLimrunInstanceClient<
  Options extends { token: string },
  Client extends object,
>(
  connect: (options: Options & typeof LIMRUN_INSTANCE_CLIENT_LOGGING) => Promise<Client>,
  access: Options,
): Promise<Client> {
  const secrets = [`Bearer ${access.token}`];
  try {
    const client = await connect({ ...access, ...LIMRUN_INSTANCE_CLIENT_LOGGING });
    return withInstanceCredentialScrubbing(client, secrets);
  } catch (error) {
    throw scrubInstanceCommandFailure(error, secrets);
  }
}

/** Every `details.reason` a command sent to an attached or created instance publishes. */
const LIMRUN_INSTANCE_REASONS = {
  // The instance refused or could not answer the command; its text, with this session's credential
  // removed, is the message.
  commandFailed: { reason: 'limrun_instance_command_failed' },
} as const satisfies ReasonTable<'limrun'>;

/**
 * Wraps one connected instance client so a failure it answers with cannot carry this session's credential.
 *
 * The instance client speaks to its instance over a WebSocket and reports a rejected frame, an unreadable
 * frame, or a refused command by throwing an `Error` whose message is the peer's own text — the frame
 * itself, or the body of the reply. This plugin authenticated that channel with the instance token, and
 * an instance that echoes it does so as a bare value core's pattern redaction cannot recognise. So every
 * method of the client is answered through this wrapper: a failure that names a value this session sent
 * is re-raised with that value removed, before reaching its caller.
 *
 * A failure that names nothing this session sent is passed through untouched, so the command that caught
 * it still answers with its own reason. A method's own answer, and a method that throws synchronously
 * before a request was made, pass through untouched too.
 */
export function withInstanceCredentialScrubbing<Client extends object>(
  client: Client,
  sentValues: Iterable<string | undefined>,
): Client {
  const secrets = [...sentValues].filter((value): value is string => typeof value === 'string');
  return new Proxy(client, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      const method = value as (...args: unknown[]) => unknown;
      return (...args: unknown[]) => {
        const answer = method.apply(target, args);
        if (!(answer instanceof Promise)) return answer;
        return answer.catch((error: unknown) => {
          // The SDK's sync response decoder can quote only a prefix of the token.
          if (property === 'syncApp' && error instanceof SyntaxError) throw new SyntaxError();
          throw scrubInstanceCommandFailure(error, secrets);
        });
      };
    },
  });
}

/**
 * Names a failed instance command with its own text, minus what this session sent. The peer's text stays
 * the message: it is the only diagnosis of a rejected command an instance gives. A failure that names
 * none of it is this plugin's caller's own error to answer for, and is returned as it came.
 */
export function scrubInstanceCommandFailure(error: unknown, secrets: readonly string[]): unknown {
  if (!(error instanceof Error)) return error;
  if (error instanceof AppError) {
    const text = safeInstanceErrorText(error.message, secrets);
    const details = scrubPublishedDetails(error.details, secrets);
    const cause = scrubPublishedCause(error.cause, secrets);
    return text === error.message && details === error.details && cause === error.cause
      ? error
      : new AppError(error.code, text, details, cause);
  }
  const text = safeInstanceErrorText(error.message, secrets);
  if (text === error.message) return error;
  return new AppError('COMMAND_FAILED', text, {
    reason: LIMRUN_INSTANCE_REASONS.commandFailed.reason,
  });
}

/**
 * Removes this session's credentials from an error this process is about to publish.
 *
 * The message, every string of the details, and a cause's message go: a failure that reached a caller's
 * `--json` output, a daemon record, or a log line cannot be taken back, and core's redaction only answers
 * for the values it recognises by pattern. An attached instance or a forwarding service in front of one is
 * given this session's token to authenticate with and answers with its own text, so a bare echo of that
 * token is the case no pattern can see.
 */
export function scrubPublishedError(
  error: unknown,
  sentValues: Iterable<string | undefined>,
): unknown {
  if (!(error instanceof AppError)) return error;
  const secrets = [...sentValues].filter((value): value is string => typeof value === 'string');
  if (secrets.length === 0) return error;
  const message = safeInstanceErrorText(error.message, secrets);
  const details = scrubPublishedDetails(error.details, secrets);
  const cause = scrubPublishedCause(error.cause, secrets);
  if (message === error.message && details === error.details && cause === error.cause) return error;
  return new AppError(error.code, message, details, cause);
}

/**
 * Removes this session's credentials from a cause this process publishes alongside a failure. Core reads a
 * cause for its code and its message only, so those are the two parts a peer's text reaches, and a cause
 * that named a sent value is rebuilt with just them.
 */
function scrubPublishedCause(cause: unknown, secrets: readonly string[]): unknown {
  if (!(cause instanceof Error)) return cause;
  const message = safeInstanceErrorText(cause.message, secrets);
  if (message === cause.message) return cause;
  return cause instanceof AppError ? new AppError(cause.code, message) : new Error(message);
}

function scrubPublishedDetails(
  details: Record<string, unknown> | undefined,
  sentValues: Iterable<string | undefined>,
): Record<string, unknown> | undefined {
  if (details === undefined) return undefined;
  const secrets = [...sentValues].filter((value): value is string => typeof value === 'string');
  if (secrets.length === 0) return details;
  const scrubbed = scrubInstanceDiagnostic(details, secrets) as Record<string, unknown>;
  if (scrubbed === details) return details;
  for (const key of ['status', 'statusCode', 'exitCode']) {
    const status = details[key];
    if (typeof status === 'number') scrubbed[key] = status;
  }
  return scrubbed;
}

/** Rebuilds only the strings of a diagnostic value that name a sent credential; a type is preserved. */
export function scrubInstanceDiagnostic(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === 'string') {
    const scrubbed = safeInstanceErrorText(value, secrets);
    return scrubbed === value ? value : scrubbed;
  }
  if (Array.isArray(value)) {
    const entries = value.map((entry) => scrubInstanceDiagnostic(entry, secrets));
    return entries.every((entry, index) => entry === value[index]) ? value : entries;
  }
  if (value === null || typeof value !== 'object' || ArrayBuffer.isView(value)) return value;
  const original = Object.entries(value);
  const entries = original
    .filter(([key]) => safeInstanceErrorText(key, secrets) === key)
    .map(([key, entry]) => [key, scrubInstanceDiagnostic(entry, secrets)] as const);
  return entries.length === original.length &&
    entries.every(([, entry], index) => entry === original[index]?.[1])
    ? value
    : Object.fromEntries(entries);
}
