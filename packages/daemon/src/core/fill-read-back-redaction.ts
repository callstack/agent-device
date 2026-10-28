/**
 * A sensitive fill's literal is redacted by exact match, but a backend reads the field back after
 * typing, and the field may hold a reformatted or partly dropped form of it. The owner that knows
 * the fill is sensitive replaces every read-back value outright instead of matching altered forms.
 */

type ReadBackRecord = Record<string, unknown>;

/** The fields `FillUnconfirmedVerification` carries as text. A null read-back reveals nothing. */
const UNCONFIRMED_READ_BACK_FIELDS = ['requested', 'before', 'after'] as const;

/** The text fields of an Android fill failure's `details`, and of its two observed input nodes. */
const FAILURE_READ_BACK_FIELDS = ['expected', 'actual'] as const;
const FAILURE_INPUT_NODE_FIELDS = ['targetInput', 'actualInput'] as const;

/**
 * Replaces the text a sensitive fill's response read back from the field: the unconfirmed
 * evidence, and the diff lines and tail labels of a `--settle` observation. Refs, counts and
 * summaries stay. This runs before literal parameterization, so a short literal cannot rewrite
 * the `verification` discriminator this checks.
 */
export function redactFillReadBack<TPayload extends ReadBackRecord | undefined>(
  payload: TPayload,
  placeholder: string,
): TPayload {
  if (!payload) return payload;
  const unconfirmed =
    payload.verification === 'unconfirmed'
      ? placeholderFields(payload, UNCONFIRMED_READ_BACK_FIELDS, placeholder)
      : {};
  return {
    ...payload,
    ...unconfirmed,
    ...(isRecord(payload.settle)
      ? { settle: redactSettleReadBack(payload.settle, placeholder) }
      : {}),
  };
}

function redactSettleReadBack(settle: ReadBackRecord, placeholder: string): ReadBackRecord {
  const { diff, tail } = settle;
  return {
    ...settle,
    ...(isRecord(diff) && Array.isArray(diff.lines)
      ? {
          diff: {
            ...diff,
            lines: diff.lines.map((line) => redactTextField(line, 'text', placeholder)),
          },
        }
      : {}),
    ...(Array.isArray(tail)
      ? { tail: tail.map((entry) => redactTextField(entry, 'label', placeholder)) }
      : {}),
  };
}

function redactTextField(entry: unknown, field: string, placeholder: string): unknown {
  return isRecord(entry) ? { ...entry, ...placeholderFields(entry, [field], placeholder) } : entry;
}

/** A backend fill failure is typed by `failureReason`; only that shape carries read-back text. */
export function redactFillFailureReadBack(details: unknown, placeholder: string): unknown {
  if (!isRecord(details) || typeof details.failureReason !== 'string') return details;
  const nodes = Object.fromEntries(
    FAILURE_INPUT_NODE_FIELDS.flatMap((field) => {
      const node = details[field];
      return isRecord(node)
        ? [[field, { ...node, ...placeholderFields(node, ['text'], placeholder) }]]
        : [];
    }),
  );
  return {
    ...details,
    ...placeholderFields(details, FAILURE_READ_BACK_FIELDS, placeholder),
    ...nodes,
  };
}

function placeholderFields(
  record: ReadBackRecord,
  fields: readonly string[],
  placeholder: string,
): ReadBackRecord {
  return Object.fromEntries(
    fields
      .filter((field) => typeof record[field] === 'string')
      .map((field) => [field, placeholder]),
  );
}

function isRecord(value: unknown): value is ReadBackRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
