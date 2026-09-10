import { AppError } from '@agent-device/kernel/errors';

/**
 * Translates `am start` extra flags into Appium's `mobile: startActivity` `extras` argument.
 *
 * agent-device's Android launch arguments are raw `am start` tokens (`--es key value`), because the
 * local Android path shells out to `am start` directly. UIAutomator2 instead takes a typed tuple
 * list, `[['s', 'key', 'value']]`, and its type names are the `am start` flag suffixes.
 *
 * The mapping is the contract. An unrecognised token raises rather than being dropped: Appium only
 * validates the type field, so a malformed key/value pair would otherwise reach the device as a
 * silently missing extra.
 */

/** `am start` extra types that carry a key and a value. */
const VALUE_EXTRA_TYPES = [
  's',
  'z',
  'i',
  'l',
  'f',
  'u',
  'cn',
  'ia',
  'ial',
  'la',
  'lal',
  'fa',
  'fal',
  'sa',
  'sal',
] as const;

/** `--esn <key>` sets a null string, so it is the one type that takes no value. */
const NULL_STRING_EXTRA_TYPE = 'sn';

export type AndroidIntentExtra = readonly string[];

/**
 * Builds the `pkg/activity` component an `am start` intent needs.
 *
 * A caller may already have passed a full component through `--activity`, and `am start` rejects a
 * doubled package, so an argument that already names one is passed through.
 */
export function qualifyAndroidActivity(appId: string, activity: string): string {
  return activity.includes('/') ? activity : `${appId}/${activity}`;
}

export function parseAndroidIntentExtras(launchArgs: readonly string[]): AndroidIntentExtra[] {
  const extras: AndroidIntentExtra[] = [];
  let index = 0;
  while (index < launchArgs.length) {
    const token = launchArgs[index] ?? '';
    const type = extraTypeForFlag(token);
    const key = launchArgs[index + 1];
    if (key === undefined) throw missingOperand(token, 'a key');
    if (type === NULL_STRING_EXTRA_TYPE) {
      extras.push([type, key]);
      index += 2;
      continue;
    }
    const value = launchArgs[index + 2];
    if (value === undefined) throw missingOperand(token, 'a value');
    extras.push([type, key, value]);
    index += 3;
  }
  return extras;
}

function extraTypeForFlag(token: string): string {
  const type = token.startsWith('--e') ? token.slice(3) : undefined;
  if (type === NULL_STRING_EXTRA_TYPE) return type;
  if (type && (VALUE_EXTRA_TYPES as readonly string[]).includes(type)) return type;
  throw new AppError(
    'INVALID_ARGS',
    `Unsupported Android launch argument: ${token || '(empty)'}.`,
    {
      hint: `Android launch arguments are am start extras. Use --e<type> <key> <value>, where type is one of ${[...VALUE_EXTRA_TYPES, NULL_STRING_EXTRA_TYPE].join(', ')}.`,
      token,
    },
  );
}

function missingOperand(token: string, operand: string): AppError {
  return new AppError('INVALID_ARGS', `Android launch argument ${token} is missing ${operand}.`, {
    hint: `Pass ${token} <key>${token === '--esn' ? '' : ' <value>'}.`,
    token,
  });
}
