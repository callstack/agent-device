import { AppError } from '@agent-device/kernel/errors';

/**
 * The telephony events an emulator can be asked to simulate: an incoming voice call (`call`),
 * answering it (`accept`), ending it (`cancel`), and an inbound text message (`sms`).
 */
export const TELEPHONY_CALL_ACTIONS = ['call', 'accept', 'cancel'] as const;
export const TELEPHONY_ACTIONS = [...TELEPHONY_CALL_ACTIONS, 'sms'] as const;
type TelephonyAction = (typeof TELEPHONY_ACTIONS)[number];
type TelephonyCallAction = (typeof TELEPHONY_CALL_ACTIONS)[number];

export const TELEPHONY_USAGE =
  'telephony call|accept|cancel <number> | telephony sms <number> <text>';

/**
 * A caller number: digits with an optional leading `+`, at most the 15 digits of an E.164 number,
 * which also fits the emulator modem's 16-character call number field.
 */
const TELEPHONY_NUMBER_PATTERN = /^\+?\d{1,15}$/;
/**
 * The emulator console reads one command per line, so a line break inside the text would end the
 * `sms send` command and start another. Line breaks are escaped for the console instead (a CRLF
 * pair counts as one); every other control character, including a lone CR, is refused.
 */
// eslint-disable-next-line no-control-regex
const TELEPHONY_TEXT_FORBIDDEN_CHARACTERS = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/;

/** Neutral intent for one telephony event, already validated by {@link parseTelephonyEventInput}. */
export type TelephonyEventInput =
  | Readonly<{ action: TelephonyCallAction; number: string }>
  | Readonly<{ action: 'sms'; number: string; text: string }>;

function parseTelephonyAction(input: unknown): TelephonyAction {
  if (input === undefined) {
    throw new AppError('INVALID_ARGS', `telephony requires an action. Use ${TELEPHONY_USAGE}.`);
  }
  const normalized = typeof input === 'string' ? input.trim().toLowerCase() : undefined;
  const action = TELEPHONY_ACTIONS.find((candidate) => candidate === normalized);
  if (!action) {
    throw new AppError(
      'INVALID_ARGS',
      `Invalid telephony action: ${String(input)}. Use ${TELEPHONY_ACTIONS.join(', ')}.`,
    );
  }
  return action;
}

export function parseTelephonyEventInput(
  input: Readonly<{ action?: unknown; number?: unknown; text?: unknown }>,
): TelephonyEventInput {
  const action = parseTelephonyAction(input.action);
  const number = parseTelephonyNumber(input.number, action);
  if (action !== 'sms') {
    if (input.text !== undefined) {
      throw new AppError('INVALID_ARGS', `telephony ${action} takes only a phone number.`);
    }
    return { action, number };
  }
  return { action, number, text: parseTelephonySmsText(input.text) };
}

/**
 * `telephony <action> <number> [text…]` as the CLI and the daemon receive it. The words after the
 * number are the SMS text, joined with single spaces the way an unquoted shell argument list splits.
 */
export function parseTelephonyPositionals(positionals: readonly string[]): TelephonyEventInput {
  const [action, number, ...words] = positionals;
  return parseTelephonyEventInput({
    action,
    number,
    text: words.length > 0 ? words.join(' ') : undefined,
  });
}

/** The daemon positionals for one validated event; the inverse of {@link parseTelephonyPositionals}. */
export function telephonyPositionals(input: TelephonyEventInput): string[] {
  return input.action === 'sms'
    ? [input.action, input.number, input.text]
    : [input.action, input.number];
}

function parseTelephonyNumber(input: unknown, action: TelephonyAction): string {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new AppError('INVALID_ARGS', `telephony ${action} requires a phone number.`);
  }
  const number = input.trim();
  if (!TELEPHONY_NUMBER_PATTERN.test(number)) {
    throw new AppError('INVALID_ARGS', `Invalid phone number: ${number}.`, {
      hint: 'Use digits with an optional leading +, for example 5551234 or +15551234567.',
    });
  }
  return number;
}

function parseTelephonySmsText(input: unknown): string {
  if (typeof input !== 'string' || input === '') {
    throw new AppError('INVALID_ARGS', 'telephony sms requires message text.');
  }
  const text = input.replaceAll('\r\n', '\n');
  if (TELEPHONY_TEXT_FORBIDDEN_CHARACTERS.test(text)) {
    throw new AppError('INVALID_ARGS', 'telephony sms text must not contain control characters.', {
      hint: 'Line breaks (LF or CRLF) are allowed; tabs, lone carriage returns, and other control characters are not.',
    });
  }
  return text;
}
