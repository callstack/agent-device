/**
 * How text reaches the focused Android field: the routing between provider-native injection, the
 * bundled test IME, and the adb-shell fallback, plus the shell writer all three fall back to.
 * Pointer, key, and gesture actions stay in `input-actions.ts`; what the field ended up holding is
 * `fill-verification.ts`.
 */
import type { FillUnconfirmedVerification } from '@agent-device/contracts/interactor-types';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { emitDiagnostic } from '../../utils/diagnostics.ts';
import { shellQuoteIfNeeded } from '../../utils/shell-quote.ts';
import {
  resolveAndroidAdbExecutor,
  resolveAndroidAdbProvider,
  resolveAndroidTextInjector,
  type AndroidTextInputAction,
} from './adb-executor.ts';
import { runAndroidAdb, sleep } from './adb.ts';
import { getAndroidKeyboardState, type AndroidKeyboardState } from './device-input-state.ts';
import {
  buildAndroidFillUnconfirmedVerification,
  completeAndroidFillVerification,
  readAndroidFillTargetBeforeMutation,
  verifyAndroidFilledText,
  type AndroidFillVerification,
} from './fill-verification.ts';
import {
  clearAndroidImeHelperText,
  isAndroidImeHelperPackage,
  selectAndroidImeHelperArtifact,
  sendAndroidImeHelperText,
} from './ime-helper.ts';
import { isAndroidTestImeActive } from './ime-lifecycle.ts';
import { focusAndroid } from './input-actions.ts';
import type { AndroidHelperSessionOptions } from './snapshot-helper-types.ts';

/**
 * `input text` truncates long strings in some app/IME states (#531), so ASCII is written in short
 * chunks rather than one command. Do not raise this to buy back spawns — the IME helper's batch
 * broadcast is the lever for that, and it does not truncate.
 */
const ANDROID_INPUT_TEXT_CHUNK_SIZE = 8;

export async function typeAndroid(device: DeviceInfo, text: string, delayMs = 0): Promise<void> {
  const providerText = resolveAndroidTextInjector(device);
  if (providerText) {
    await providerText({ action: 'type', text, delayMs });
    emitAndroidTextDiagnostic('type', 'provider-native', text);
    return;
  }
  if (isAndroidTestImeActive(device)) {
    await typeAndroidImeHelper(
      device,
      await activatedAndroidImeHelperPackage(device),
      text,
      delayMs,
    );
    return;
  }
  // The shell path needs the input-method read anyway, and it also names the device's active IME.
  // If that is the helper, its batch channel writes the whole string in one broadcast instead of
  // ceil(n/8) `input text` spawns — no flag, no IME switch, nothing this process had to arrange.
  // Read it before refusing anything: what the text has to be encodable for is not known until the
  // channel is, and the broadcast channel carries any Unicode.
  const inputState = await readAndroidShellTextInputState(device, 'type');
  const helperPackage = androidImeHelperInputMethod(inputState);
  if (helperPackage) {
    await typeAndroidImeHelper(device, helperPackage, text, delayMs);
    return;
  }
  assertAndroidShellTextSupported(text);
  assertAndroidShellInputIsAppOwned(inputState, 'type');
  if (delayMs > 0 && Array.from(text).length > 1) {
    await typeAndroidShell(device, { action: 'type', text, chunkSize: 1, delayMs });
    return;
  }
  await typeAndroidShell(device, {
    action: 'type',
    text,
    chunkSize: ANDROID_INPUT_TEXT_CHUNK_SIZE,
    delayMs: 0,
  });
}

export async function fillAndroid(
  device: DeviceInfo,
  x: number,
  y: number,
  text: string,
  delayMs = 0,
  helper: AndroidHelperSessionOptions = {},
): Promise<FillUnconfirmedVerification | void> {
  const beforeTarget = await readAndroidFillTargetBeforeMutation(device, x, y, helper);
  const providerText = resolveAndroidTextInjector(device);
  if (providerText) {
    await providerText({ action: 'fill', target: { x, y }, text, delayMs });
    emitAndroidTextDiagnostic('fill', 'provider-native', text);
    const verification = await verifyAndroidFilledText(device, x, y, text, helper);
    return completeAndroidFillVerification(text, beforeTarget, verification);
  }
  if (isAndroidTestImeActive(device)) {
    const verification = await fillAndroidImeHelper(
      device,
      await activatedAndroidImeHelperPackage(device),
      x,
      y,
      text,
      beforeTarget,
      helper,
    );
    return completeAndroidFillVerification(text, beforeTarget, verification);
  }

  const textCodePointLength = Array.from(text).length;
  const attempts: Array<{
    clearPadding: number;
    minClear: number;
    maxClear: number;
    chunkSize: number;
    inputDelayMs: number;
  }> = [
    {
      clearPadding: 12,
      minClear: 8,
      maxClear: 48,
      chunkSize: delayMs > 0 ? 1 : ANDROID_INPUT_TEXT_CHUNK_SIZE,
      inputDelayMs: delayMs,
    },
    {
      clearPadding: 24,
      minClear: 16,
      maxClear: 96,
      chunkSize: delayMs > 0 ? 1 : 4,
      inputDelayMs: delayMs > 0 ? delayMs : 15,
    },
  ];

  let lastVerification: AndroidFillVerification | null = null;

  for (const attempt of attempts) {
    await focusAndroid(device, x, y);
    // Same read, same reason, same ordering as `typeAndroid`: when the helper is the active IME its
    // channel replaces both the delete-key clear and the chunked write for the rest of this fill,
    // and the ASCII limit that would refuse this text applies only once the shell path is chosen.
    const inputState = await readAndroidShellTextInputState(device, 'fill');
    const helperPackage = androidImeHelperInputMethod(inputState);
    if (helperPackage) {
      const verification = await fillAndroidImeHelper(
        device,
        helperPackage,
        x,
        y,
        text,
        beforeTarget,
        helper,
      );
      return completeAndroidFillVerification(text, beforeTarget, verification);
    }
    assertAndroidShellTextSupported(text);
    assertAndroidShellInputIsAppOwned(inputState, 'fill');
    const clearCount = clampCount(
      textCodePointLength + attempt.clearPadding,
      attempt.minClear,
      attempt.maxClear,
    );
    await clearFocusedText(device, clearCount);
    await typeAndroidShell(device, {
      action: 'fill',
      text,
      chunkSize: attempt.chunkSize,
      delayMs: attempt.inputDelayMs,
    });
    const verification = await verifyAndroidFilledText(device, x, y, text, helper);
    lastVerification = verification;
    if (verification.ok) return;
    if (verification.reason === 'ime_capture') {
      return completeAndroidFillVerification(text, beforeTarget, verification);
    }
    const unconfirmed = buildAndroidFillUnconfirmedVerification(text, beforeTarget, verification);
    if (unconfirmed) return unconfirmed;
  }

  return completeAndroidFillVerification(text, beforeTarget, lastVerification);
}

/**
 * The helper package this process switched the device to. The observed-IME route reads the package
 * off the device instead, so it never depends on a packaged artifact being present.
 */
async function activatedAndroidImeHelperPackage(device: DeviceInfo): Promise<string> {
  const artifact = await selectAndroidImeHelperArtifact(resolveAndroidAdbProvider(device));
  return artifact.manifest.packageName;
}

function androidImeHelperInputMethod(state: AndroidKeyboardState | null): string | undefined {
  const packageName = state?.inputMethodPackage;
  return isAndroidImeHelperPackage(packageName) ? packageName : undefined;
}

async function typeAndroidImeHelper(
  device: DeviceInfo,
  packageName: string,
  text: string,
  delayMs: number,
): Promise<void> {
  const adb = resolveAndroidAdbExecutor(device);
  const parts = text.split('\n');
  for (const [partIndex, part] of parts.entries()) {
    const chunks = delayMs > 0 ? chunkAndroidInputText(part, 1) : [part];
    for (const [chunkIndex, chunk] of chunks.entries()) {
      if (chunk) await sendAndroidImeHelperText(adb, packageName, chunk);
      if (delayMs > 0 && (chunkIndex + 1 < chunks.length || partIndex + 1 < parts.length)) {
        await sleep(delayMs);
      }
    }
    if (partIndex + 1 < parts.length) {
      await runAndroidAdb(device, ['shell', 'input', 'keyevent', 'ENTER']);
    }
  }
  emitAndroidTextDiagnostic('type', 'test-ime', text);
}

async function fillAndroidImeHelper(
  device: DeviceInfo,
  packageName: string,
  x: number,
  y: number,
  text: string,
  beforeTarget: AndroidFillVerification['targetInput'],
  helper: AndroidHelperSessionOptions,
): Promise<AndroidFillVerification> {
  const adb = resolveAndroidAdbExecutor(device);
  let lastVerification: AndroidFillVerification | null = null;
  // One retry covers the rare not-yet-bound InputConnection right after focus.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await focusAndroid(device, x, y);
    await clearAndroidImeHelperText(adb, packageName);
    if (text) await sendAndroidImeHelperText(adb, packageName, text);
    const verification = await verifyAndroidFilledText(device, x, y, text, helper);
    lastVerification = verification;
    if (verification.ok) break;
    if (buildAndroidFillUnconfirmedVerification(text, beforeTarget, verification)) break;
  }
  emitAndroidTextDiagnostic('fill', 'test-ime', text);
  return lastVerification as AndroidFillVerification;
}

async function typeAndroidShell(
  device: DeviceInfo,
  options: { action: AndroidTextInputAction; text: string; chunkSize: number; delayMs: number },
): Promise<void> {
  const parts = options.text.split('\n');
  for (const [partIndex, part] of parts.entries()) {
    const chunks = chunkAndroidInputText(part, options.chunkSize);
    for (const [chunkIndex, chunk] of chunks.entries()) {
      await typeAndroidShellChunk(device, chunk);
      if (options.delayMs > 0 && (chunkIndex + 1 < chunks.length || partIndex + 1 < parts.length)) {
        await sleep(options.delayMs);
      }
    }
    if (partIndex + 1 < parts.length) {
      await runAndroidAdb(device, ['shell', 'input', 'keyevent', 'ENTER']);
    }
  }
  emitAndroidTextDiagnostic(options.action, 'adb-shell', options.text);
}

async function typeAndroidShellChunk(device: DeviceInfo, text: string): Promise<void> {
  if (!text) return;
  try {
    await runAndroidAdb(device, [
      'shell',
      'input',
      'text',
      shellQuoteIfNeeded(encodeAndroidInputText(text)),
    ]);
  } catch (error) {
    if (isAndroidInputTextUnsupported(error)) {
      throw unsupportedAndroidShellTextError(text, error);
    }
    throw error;
  }
}

async function clearFocusedText(device: DeviceInfo, count: number): Promise<void> {
  const deletes = Math.max(0, count);
  await runAndroidAdb(device, ['shell', 'input', 'keyevent', 'KEYCODE_MOVE_END'], {
    allowFailure: true,
  });
  const batchSize = 24;
  for (let i = 0; i < deletes; i += batchSize) {
    const size = Math.min(batchSize, deletes - i);
    await runAndroidAdb(
      device,
      ['shell', 'input', 'keyevent', ...Array(size).fill('KEYCODE_DEL')],
      {
        allowFailure: true,
      },
    );
  }
}

/**
 * Reads the device's input-method state for a text-entry decision, or `null` when the probe itself
 * fails. A failed probe is not a refusal: the shell path has always continued without this evidence
 * rather than blocking text entry on a diagnostic read.
 */
async function readAndroidShellTextInputState(
  device: DeviceInfo,
  action: AndroidTextInputAction,
): Promise<AndroidKeyboardState | null> {
  try {
    return await getAndroidKeyboardState(device);
  } catch (error) {
    emitDiagnostic({
      level: 'warn',
      phase: 'android_input_ownership_probe_failed',
      data: {
        action,
        error: error instanceof Error ? error.message : String(error),
      },
    });
    return null;
  }
}

function assertAndroidShellInputIsAppOwned(
  state: AndroidKeyboardState | null,
  action: AndroidTextInputAction,
): void {
  if (!state || state.inputOwner !== 'ime') return;
  throw new AppError(
    'COMMAND_FAILED',
    'KEYBOARD_OVERLAY_BLOCKING: Android text input is blocked because the focused input belongs to the active keyboard/IME.',
    {
      failureReason: 'ime_capture',
      action,
      inputOwner: state.inputOwner,
      inputType: state.inputType,
      type: state.type,
      inputMethodPackage: state.inputMethodPackage,
      focusedPackage: state.focusedPackage,
      focusedResourceId: state.focusedResourceId,
      nextAction:
        'Focused input appears to be owned by the keyboard/IME; dismiss or change the IME before retrying text entry.',
    },
  );
}

function assertAndroidShellTextSupported(text: string): void {
  if (isAndroidShellTextSupported(text)) return;
  throw unsupportedAndroidShellTextError(text);
}

function isAndroidShellTextSupported(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0);
    if (code === undefined) continue;
    if (char === '\n') continue;
    if (code < 0x20 || code > 0x7e) {
      return false;
    }
  }
  return true;
}

function encodeAndroidInputText(text: string): string {
  // Android shell input uses `%s` as the escaped token for spaces.
  return text.replace(/ /g, '%s');
}

function isAndroidInputTextUnsupported(error: unknown): boolean {
  if (!(error instanceof AppError)) return false;
  if (error.code !== 'COMMAND_FAILED') return false;
  const rawStderr = error.details?.stderr;
  const stderr = (typeof rawStderr === 'string' ? rawStderr : '').toLowerCase();
  if (stderr.includes("exception occurred while executing 'text'")) return true;
  if (stderr.includes('nullpointerexception') && stderr.includes('inputshellcommand.sendtext'))
    return true;
  return false;
}

function unsupportedAndroidShellTextError(text: string, cause?: unknown): AppError {
  return new AppError(
    'COMMAND_FAILED',
    'Android text input requires provider-native text injection or the bundled test IME helper for non-ASCII/control characters; the adb-shell fallback supports ASCII text only. On emulators the test IME activates automatically; on real devices pass `open --test-ime` to enable it (see `agent-device doctor` for the current IME state).',
    {
      backend: 'adb-shell',
      textLength: Array.from(text).length,
      textPreview: text.slice(0, 32),
    },
    cause instanceof Error ? cause : undefined,
  );
}

function chunkAndroidInputText(text: string, chunkSize: number): string[] {
  const size = Math.max(1, Math.floor(chunkSize));
  const chunks: string[] = [];
  const chars = Array.from(text);
  for (let i = 0; i < chars.length; i += size) {
    chunks.push(chars.slice(i, i + size).join(''));
  }
  return chunks.length > 0 ? chunks : [''];
}

function emitAndroidTextDiagnostic(
  action: AndroidTextInputAction,
  backend: 'provider-native' | 'adb-shell' | 'test-ime',
  text: string,
): void {
  emitDiagnostic({
    phase: 'android_text_injection',
    data: { action, backend, textLength: Array.from(text).length },
  });
}

function clampCount(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
