import type { ShellWord } from '@agent-device/kernel/device-shell';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import type { DeviceInfo } from '@agent-device/kernel/device';
import {
  AppError,
  discloseDispatchAfterSteps,
  KEYBOARD_DISMISS_REASONS,
} from '@agent-device/kernel/errors';

import { sleep } from './adb.ts';
import {
  androidAdbResultError,
  resolveAndroidAdbExecutor,
  runAdbShell,
  type AndroidAdbExecutor,
} from './adb-executor.ts';
import type { AndroidClipboardOperation } from './clipboard-shell-response.ts';
import {
  type AndroidInputOwner,
  classifyAndroidInputOwner,
  isFallbackAndroidInputMethodPackage,
  isFallbackAndroidInputMethodResource,
  readAndroidActiveInputMethodPackage,
} from '@agent-device/contracts/android-input-ownership';
import type { KeyboardReturnKey } from '@agent-device/contracts/keyboard';

const ANDROID_INPUT_TYPE_CLASS_MASK = 0x0000000f;
const ANDROID_INPUT_TYPE_CLASS_TEXT = 0x00000001;
const ANDROID_INPUT_TYPE_CLASS_NUMBER = 0x00000002;
const ANDROID_INPUT_TYPE_CLASS_PHONE = 0x00000003;
const ANDROID_INPUT_TYPE_CLASS_DATETIME = 0x00000004;
const ANDROID_INPUT_TYPE_VARIATION_MASK = 0x00000ff0;
const ANDROID_TEXT_VARIATION_EMAIL_ADDRESS = 0x00000020;
const ANDROID_TEXT_VARIATION_WEB_EMAIL_ADDRESS = 0x000000d0;
const ANDROID_TEXT_VARIATION_PASSWORD = 0x00000080;
const ANDROID_TEXT_VARIATION_WEB_PASSWORD = 0x000000e0;
const ANDROID_TEXT_VARIATION_VISIBLE_PASSWORD = 0x00000090;
/** `EditorInfo.IME_MASK_ACTION`: the bits of `imeOptions` that name the return key's action. */
const ANDROID_IME_MASK_ACTION = 0x000000ff;
/** `EditorInfo.IME_FLAG_NO_ENTER_ACTION`: the action stays off the enter key, which is then enter. */
const ANDROID_IME_FLAG_NO_ENTER_ACTION = 0x40000000;
const ANDROID_KEYBOARD_DISMISS_MAX_ATTEMPTS = 2;
const ANDROID_KEYBOARD_DISMISS_RETRY_DELAY_MS = 120;
const ANDROID_KEYCODE_ESCAPE = '111';
const ANDROID_KEYBOARD_VISIBILITY_KEYS = [
  'mInputShown',
  'mIsInputViewShown',
  'isInputViewShown',
  'mDecorViewVisible',
  'mWindowVisible',
  'mInShowWindow',
];
const ANDROID_KEYBOARD_CLASS_BY_INPUT_CLASS = new Map<number, AndroidKeyboardType>([
  [ANDROID_INPUT_TYPE_CLASS_NUMBER, 'number'],
  [ANDROID_INPUT_TYPE_CLASS_PHONE, 'phone'],
  [ANDROID_INPUT_TYPE_CLASS_DATETIME, 'datetime'],
]);
const ANDROID_EMAIL_TEXT_VARIATIONS = new Set([
  ANDROID_TEXT_VARIATION_EMAIL_ADDRESS,
  ANDROID_TEXT_VARIATION_WEB_EMAIL_ADDRESS,
]);
const ANDROID_PASSWORD_TEXT_VARIATIONS = new Set([
  ANDROID_TEXT_VARIATION_PASSWORD,
  ANDROID_TEXT_VARIATION_WEB_PASSWORD,
  ANDROID_TEXT_VARIATION_VISIBLE_PASSWORD,
]);

type AndroidKeyboardType =
  | 'text'
  | 'number'
  | 'email'
  | 'phone'
  | 'password'
  | 'datetime'
  | 'unknown';

/** `EditorInfo.IME_ACTION_*`: the action one masked bit pattern names. */
const ANDROID_IME_RETURN_KEY_BY_ACTION: ReadonlyMap<number, KeyboardReturnKey> = new Map([
  [0x01, 'none'],
  [0x02, 'go'],
  [0x03, 'search'],
  [0x04, 'send'],
  [0x05, 'next'],
  [0x06, 'done'],
  [0x07, 'previous'],
]);

export type AndroidKeyboardState = {
  visible: boolean;
  inputType?: string;
  type?: AndroidKeyboardType;
  inputMethodPackage?: string;
  focusedPackage?: string;
  focusedResourceId?: string;
  inputOwner: AndroidInputOwner;
  /** What the current editor's return key offers; absent when the keyboard is not visible. */
  returnKey?: KeyboardReturnKey;
  /** The editor's own custom action label, with its surrounding whitespace trimmed; absent when the
   *  editor names none. */
  returnKeyLabel?: string;
};

export type AndroidKeyboardDismissResult = AndroidKeyboardState & {
  attempts: number;
  wasVisible: boolean;
  dismissed: boolean;
};

export async function getAndroidKeyboardState(device: DeviceInfo): Promise<AndroidKeyboardState> {
  return await getAndroidKeyboardStatusWithAdb(resolveAndroidAdbExecutor(device));
}

export async function getAndroidKeyboardStatusWithAdb(
  adb: AndroidAdbExecutor,
): Promise<AndroidKeyboardState> {
  const result = await runAdbShell(adb, ['dumpsys', 'input_method'], {
    allowFailure: true,
  });
  if (result.exitCode !== 0) {
    throw androidAdbResultError('Failed to query Android keyboard state', result);
  }
  return parseAndroidKeyboardState(result.stdout);
}

export async function dismissAndroidKeyboard(
  device: DeviceInfo,
): Promise<AndroidKeyboardDismissResult> {
  return await dismissAndroidKeyboardWithAdb(resolveAndroidAdbExecutor(device));
}

export async function dismissAndroidKeyboardWithAdb(
  adb: AndroidAdbExecutor,
): Promise<AndroidKeyboardDismissResult> {
  const initialState = await getAndroidKeyboardStatusWithAdb(adb);
  let state = initialState;
  let attempts = 0;

  try {
    while (state.visible && attempts < ANDROID_KEYBOARD_DISMISS_MAX_ATTEMPTS) {
      await runAdbShell(adb, ['input', 'keyevent', ANDROID_KEYCODE_ESCAPE]);
      attempts += 1;
      await sleep(ANDROID_KEYBOARD_DISMISS_RETRY_DELAY_MS);
      state = await getAndroidKeyboardStatusWithAdb(adb);
    }
  } catch (error) {
    throw discloseDispatchAfterSteps(error, attempts);
  }

  if (initialState.visible && state.visible) {
    throw new AppError(
      'UNSUPPORTED_OPERATION',
      'Android keyboard dismiss is unavailable for the current IME without back navigation.',
      {
        // The Escape key events went out. The final state alone cannot prove what they did.
        reason: KEYBOARD_DISMISS_REASONS.unavailable.reason,
        dispatched: 'unknown',
        attempts,
        inputType: state.inputType,
        type: state.type,
        inputMethodPackage: state.inputMethodPackage,
        focusedPackage: state.focusedPackage,
        focusedResourceId: state.focusedResourceId,
        inputOwner: state.inputOwner,
      },
    );
  }

  return {
    attempts,
    wasVisible: initialState.visible,
    dismissed: initialState.visible && !state.visible,
    visible: state.visible,
    inputType: state.inputType,
    type: state.type,
    inputMethodPackage: state.inputMethodPackage,
    focusedPackage: state.focusedPackage,
    focusedResourceId: state.focusedResourceId,
    inputOwner: state.inputOwner,
  };
}

function parseAndroidKeyboardState(stdout: string): AndroidKeyboardState {
  const visible = parseAndroidKeyboardVisibility(stdout) ?? parseLegacyImeWindowVisibility(stdout);
  const inputType = parseLastAndroidInputType(stdout);
  const focusedPackage = parseLastDumpsysValue(stdout, /\bpackageName=([A-Za-z0-9_.]+)\b/g);
  const focusedResourceId = parseLastDumpsysValue(
    stdout,
    /\b(?:resourceId|resource-id)=([^\s,}]+)/g,
  );
  const inputMethodPackage = readAndroidActiveInputMethodPackage(stdout);
  const inputOwner = classifyAndroidInputOwner(
    focusedPackage,
    focusedResourceId,
    inputMethodPackage,
  );
  emitAndroidInputOwnershipFallbackDiagnostic(
    focusedPackage,
    focusedResourceId,
    inputMethodPackage,
  );
  // The return key belongs to the visible keyboard: a hidden one keeps the editor's attributes in
  // its dump while nothing is being typed into, so its action would not be what any key offers.
  const returnKeyFacts = visible === true ? parseAndroidReturnKey(stdout) : {};

  return {
    visible: visible ?? false,
    inputType,
    type: inputType ? classifyAndroidKeyboardType(inputType) : undefined,
    inputMethodPackage,
    focusedPackage,
    focusedResourceId,
    inputOwner,
    ...returnKeyFacts,
  };
}

/**
 * What the current editor's `imeOptions` say its return key does, read from the same
 * `dumpsys input_method` output the rest of this state comes from.
 *
 * `IME_FLAG_NO_ENTER_ACTION` outranks the action bits: it asks the IME to keep the action off the
 * enter key, so the key the user presses is enter whatever the action is. Otherwise the masked
 * action names the key, and an app's custom `actionLabel` is reported beside it as the wording the
 * key shows. An unspecified action is the IME's own choice, so it answers `unknown` rather than
 * guessing which key a given IME offers. No `imeOptions` to read is also `unknown`: the keyboard is
 * up, but this read cannot say what its key does.
 */
function parseAndroidReturnKey(
  stdout: string,
): Readonly<{ returnKey?: KeyboardReturnKey; returnKeyLabel?: string }> {
  const rawImeOptions = parseLastDumpsysValue(stdout, /\bimeOptions=0x([0-9a-fA-F]+)\b/gi);
  const imeOptions = rawImeOptions ? Number.parseInt(rawImeOptions, 16) >>> 0 : Number.NaN;
  const actionLabel = parseLastDumpsysActionLabel(stdout);
  if (Number.isNaN(imeOptions)) {
    return actionLabel
      ? { returnKey: 'unknown', returnKeyLabel: actionLabel }
      : { returnKey: 'unknown' };
  }
  if ((imeOptions & ANDROID_IME_FLAG_NO_ENTER_ACTION) !== 0) {
    return { returnKey: 'enter' };
  }
  const action = imeOptions & ANDROID_IME_MASK_ACTION;
  const returnKey = ANDROID_IME_RETURN_KEY_BY_ACTION.get(action) ?? 'unknown';
  return actionLabel ? { returnKey, returnKeyLabel: actionLabel } : { returnKey };
}

/**
 * The editor's own `actionLabel`, with its surrounding whitespace trimmed. `EditorInfo.toString()`
 * writes one space-separated `key=value` run, so the label — which can hold spaces and commas, such
 * as `Submit, then Continue` — ends at the next `key=value` field or at the line. A comma only ends
 * it when a field name follows, which is how a brace-delimited dump separates its own fields.
 */
function parseLastDumpsysActionLabel(stdout: string): string | undefined {
  let label: string | undefined;
  for (const match of stdout.matchAll(/\bactionLabel=([^\n]*?)(?=\s+\w+=|,\s*\w+=|[}\]]|\s*$)/g)) {
    const value = match[1]?.trim();
    if (value && value !== 'null') label = value;
  }
  return label;
}

function parseLegacyImeWindowVisibility(stdout: string): boolean | null {
  const imeWindowVisibility = stdout.match(/\bmImeWindowVis=0x([0-9a-fA-F]+)\b/);
  const rawFlags = imeWindowVisibility?.[1];
  if (!rawFlags) return null;

  const flags = Number.parseInt(rawFlags, 16);
  if (Number.isNaN(flags)) return null;

  return (flags & 0x1) !== 0;
}

function parseLastAndroidInputType(stdout: string): string | undefined {
  const value = parseLastDumpsysValue(stdout, /\binputType=0x([0-9a-fA-F]+)\b/gi);
  return value ? `0x${value.toLowerCase()}` : undefined;
}

function parseLastDumpsysValue(stdout: string, pattern: RegExp): string | undefined {
  let value: string | undefined;
  for (const match of stdout.matchAll(pattern)) {
    value = match[1];
  }
  return value;
}

function emitAndroidInputOwnershipFallbackDiagnostic(
  focusedPackage: string | undefined,
  focusedResourceId: string | undefined,
  inputMethodPackage: string | undefined,
): void {
  if (inputMethodPackage) return;
  if (
    !isFallbackAndroidInputMethodPackage(focusedPackage) &&
    !isFallbackAndroidInputMethodResource(focusedResourceId)
  ) {
    return;
  }

  emitDiagnostic({
    level: 'warn',
    phase: 'android_input_ownership_fallback',
    data: {
      focusedPackage,
      focusedResourceId,
    },
  });
}

function parseAndroidKeyboardVisibility(stdout: string): boolean | null {
  const latestByKey = parseLatestBooleanDumpsysValues(stdout, ANDROID_KEYBOARD_VISIBILITY_KEYS);
  return resolveAndroidKeyboardVisibility(latestByKey);
}

function parseLatestBooleanDumpsysValues(stdout: string, keys: string[]): Map<string, boolean> {
  const latestByKey = new Map<string, boolean>();
  const pattern = new RegExp(`\\b(${keys.join('|')})=([a-zA-Z]+)\\b`, 'g');
  for (const match of stdout.matchAll(pattern)) {
    const key = match[1];
    const value = match[2]?.toLowerCase();
    if (!key || (value !== 'true' && value !== 'false')) continue;
    latestByKey.set(key, value === 'true');
  }
  return latestByKey;
}

function resolveAndroidKeyboardVisibility(latestByKey: Map<string, boolean>): boolean | null {
  if (latestByKey.size === 0) return null;

  const windowVisible = firstDefinedBoolean(latestByKey, [
    'mWindowVisible',
    'mDecorViewVisible',
    'mInShowWindow',
  ]);
  if (windowVisible !== undefined) return windowVisible;

  const inputShown = latestByKey.get('mInputShown');
  if (inputShown !== undefined) return inputShown;

  const inputViewShown = firstDefinedBoolean(latestByKey, [
    'mIsInputViewShown',
    'isInputViewShown',
  ]);
  return inputViewShown ?? null;
}

function firstDefinedBoolean(
  values: Map<string, boolean>,
  keys: readonly string[],
): boolean | undefined {
  for (const key of keys) {
    const value = values.get(key);
    if (value !== undefined) return value;
  }
  return undefined;
}

function classifyAndroidKeyboardType(inputType: string): AndroidKeyboardType {
  const parsed = Number.parseInt(inputType.replace(/^0x/i, ''), 16);
  if (Number.isNaN(parsed)) return 'unknown';

  const inputClass = parsed & ANDROID_INPUT_TYPE_CLASS_MASK;
  const knownInputClass = ANDROID_KEYBOARD_CLASS_BY_INPUT_CLASS.get(inputClass);
  if (knownInputClass) return knownInputClass;
  if (inputClass !== ANDROID_INPUT_TYPE_CLASS_TEXT) return 'unknown';

  const variation = parsed & ANDROID_INPUT_TYPE_VARIATION_MASK;
  if (ANDROID_EMAIL_TEXT_VARIATIONS.has(variation)) return 'email';
  if (ANDROID_PASSWORD_TEXT_VARIATIONS.has(variation)) return 'password';

  return 'text';
}

export async function readAndroidClipboardText(device: DeviceInfo): Promise<string> {
  return await readAndroidClipboardWithAdb(resolveAndroidAdbExecutor(device));
}

export async function readAndroidClipboardWithAdb(adb: AndroidAdbExecutor): Promise<string> {
  const stdout = await runAndroidClipboardShellCommand(
    adb,
    ['cmd', 'clipboard', 'get', 'text'],
    'read',
  );
  return normalizeAndroidClipboardText(stdout);
}

export async function writeAndroidClipboardText(device: DeviceInfo, text: string): Promise<void> {
  await writeAndroidClipboardWithAdb(resolveAndroidAdbExecutor(device), text);
}

export async function writeAndroidClipboardWithAdb(
  adb: AndroidAdbExecutor,
  text: string,
): Promise<void> {
  await runAndroidClipboardShellCommand(adb, ['cmd', 'clipboard', 'set', 'text', text], 'write');
}

async function runAndroidClipboardShellCommand(
  adb: AndroidAdbExecutor,
  words: readonly ShellWord[],
  operation: AndroidClipboardOperation,
): Promise<string> {
  const { androidClipboardShellCommandUnavailableError, classifyAndroidClipboardShellResponse } =
    await import('./clipboard-shell-response.ts');
  const result = await runAdbShell(adb, words, { allowFailure: true });
  const verdict = classifyAndroidClipboardShellResponse(result);
  if (verdict === 'no-shell-command') {
    throw androidClipboardShellCommandUnavailableError(operation);
  }
  if (verdict === 'call-failed') {
    throw androidAdbResultError(`Failed to ${operation} Android clipboard text`, result);
  }
  return result.stdout;
}

function normalizeAndroidClipboardText(stdout: string): string {
  const normalized = stdout.replaceAll('\r\n', '\n').replace(/\n$/, '');
  const prefixed = normalized.match(/^clipboard text:\s*(.*)$/i);
  if (prefixed) return prefixed[1] ?? '';
  if (normalized.trim().toLowerCase() === 'null') return '';
  return normalized;
}
