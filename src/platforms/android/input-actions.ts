import { AppError } from '../../kernel/errors.ts';
import type { DeviceInfo } from '../../kernel/device.ts';
import { emitDiagnostic } from '../../utils/diagnostics.ts';
import type { DeviceRotation } from '../../contracts/device-rotation.ts';
import { buildScrollGesturePlan, type ScrollDirection } from '../../contracts/scroll-gesture.ts';
import { toAndroidTvRemoteKeyevent, type TvRemoteButton } from '../../contracts/tv-remote.ts';
import { runAndroidAdb, sleep } from './adb.ts';
import {
  resolveAndroidAdbExecutor,
  resolveAndroidTextInjector,
  type AndroidTextInputAction,
} from './adb-executor.ts';
import { getAndroidKeyboardState, type AndroidKeyboardState } from './device-input-state.ts';
import {
  androidFillFailureDetails,
  androidFillFailureMessage,
  verifyAndroidFilledText,
  type AndroidFillVerification,
} from './fill-verification.ts';
import { isAndroidTestImeActive } from './ime-lifecycle.ts';
import {
  clearAndroidImeHelperText,
  resolveAndroidImeHelperArtifact,
  sendAndroidImeHelperText,
} from './ime-helper.ts';

export { readAndroidTextAtPoint } from './fill-verification.ts';

export async function pressAndroid(device: DeviceInfo, x: number, y: number): Promise<void> {
  await runAndroidAdb(device, ['shell', 'input', 'tap', String(x), String(y)]);
}

export async function pressAndroidTvRemote(
  device: DeviceInfo,
  button: TvRemoteButton,
  durationMs?: number,
): Promise<void> {
  const keyevent = toAndroidTvRemoteKeyevent(button);
  const keyeventArgs = durationMs && durationMs > 0 ? ['keyevent', '--longpress'] : ['keyevent'];
  await runAndroidAdb(device, ['shell', 'input', ...keyeventArgs, keyevent]);
}

export async function swipeAndroid(
  device: DeviceInfo,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  durationMs = 250,
): Promise<void> {
  await runAndroidAdb(device, [
    'shell',
    'input',
    'swipe',
    String(x1),
    String(y1),
    String(x2),
    String(y2),
    String(durationMs),
  ]);
}

export async function backAndroid(device: DeviceInfo): Promise<void> {
  await runAndroidAdb(device, ['shell', 'input', 'keyevent', '4']);
}

export async function homeAndroid(device: DeviceInfo): Promise<void> {
  await runAndroidAdb(device, ['shell', 'input', 'keyevent', '3']);
}

export async function pressAndroidEnter(device: DeviceInfo): Promise<void> {
  await runAndroidAdb(device, ['shell', 'input', 'keyevent', 'ENTER']);
}

export async function rotateAndroid(
  device: DeviceInfo,
  orientation: DeviceRotation,
): Promise<void> {
  const userRotation = resolveAndroidUserRotation(orientation);
  await runAndroidAdb(device, [
    'shell',
    'settings',
    'put',
    'system',
    'accelerometer_rotation',
    '0',
  ]);
  await runAndroidAdb(device, [
    'shell',
    'settings',
    'put',
    'system',
    'user_rotation',
    userRotation,
  ]);
}

export async function appSwitcherAndroid(device: DeviceInfo): Promise<void> {
  await runAndroidAdb(device, ['shell', 'input', 'keyevent', '187']);
}

export async function longPressAndroid(
  device: DeviceInfo,
  x: number,
  y: number,
  durationMs = 800,
): Promise<void> {
  await runAndroidAdb(device, [
    'shell',
    'input',
    'swipe',
    String(x),
    String(y),
    String(x),
    String(y),
    String(durationMs),
  ]);
}

export async function typeAndroid(device: DeviceInfo, text: string, delayMs = 0): Promise<void> {
  const providerText = resolveAndroidTextInjector(device);
  if (providerText) {
    await providerText({ action: 'type', text, delayMs });
    emitAndroidTextDiagnostic('type', 'provider-native', text);
    return;
  }
  if (isAndroidTestImeActive(device)) {
    await typeAndroidTestIme(device, text, delayMs);
    return;
  }
  assertAndroidShellTextSupported(text);
  await assertAndroidShellInputIsAppOwned(device, 'type');
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

export async function focusAndroid(device: DeviceInfo, x: number, y: number): Promise<void> {
  await pressAndroid(device, x, y);
}

export async function fillAndroid(
  device: DeviceInfo,
  x: number,
  y: number,
  text: string,
  delayMs = 0,
): Promise<void> {
  const providerText = resolveAndroidTextInjector(device);
  if (providerText) {
    await providerText({ action: 'fill', target: { x, y }, text, delayMs });
    emitAndroidTextDiagnostic('fill', 'provider-native', text);
    const verification = await verifyAndroidFilledText(device, x, y, text);
    if (verification.ok) return;
    throwAndroidFillFailure(text, verification);
  }
  if (isAndroidTestImeActive(device)) {
    const verification = await fillAndroidTestIme(device, x, y, text);
    if (verification.ok) return;
    throwAndroidFillFailure(text, verification);
  }
  assertAndroidShellTextSupported(text);

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
    await assertAndroidShellInputIsAppOwned(device, 'fill');
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
    const verification = await verifyAndroidFilledText(device, x, y, text);
    lastVerification = verification;
    if (verification.ok) return;
    if (verification.reason === 'ime_capture') {
      throwAndroidFillFailure(text, verification);
    }
  }

  throwAndroidFillFailure(text, lastVerification);
}

async function typeAndroidTestIme(
  device: DeviceInfo,
  text: string,
  delayMs: number,
): Promise<void> {
  const adb = resolveAndroidAdbExecutor(device);
  const artifact = await resolveAndroidImeHelperArtifact();
  const packageName = artifact.manifest.packageName;
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

async function fillAndroidTestIme(
  device: DeviceInfo,
  x: number,
  y: number,
  text: string,
): Promise<AndroidFillVerification> {
  const adb = resolveAndroidAdbExecutor(device);
  const artifact = await resolveAndroidImeHelperArtifact();
  const packageName = artifact.manifest.packageName;
  let lastVerification: AndroidFillVerification | null = null;
  // One retry covers the rare not-yet-bound InputConnection right after focus.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await focusAndroid(device, x, y);
    await clearAndroidImeHelperText(adb, packageName);
    if (text) await sendAndroidImeHelperText(adb, packageName, text);
    const verification = await verifyAndroidFilledText(device, x, y, text);
    lastVerification = verification;
    if (verification.ok) break;
  }
  emitAndroidTextDiagnostic('fill', 'test-ime', text);
  return lastVerification as AndroidFillVerification;
}

function throwAndroidFillFailure(
  expected: string,
  verification: AndroidFillVerification | null,
): never {
  throw new AppError(
    'COMMAND_FAILED',
    androidFillFailureMessage(verification),
    androidFillFailureDetails(expected, verification),
  );
}

export async function scrollAndroid(
  device: DeviceInfo,
  direction: ScrollDirection,
  options?: { amount?: number; pixels?: number; durationMs?: number },
): Promise<Record<string, unknown>> {
  const size = await getAndroidScreenSize(device);
  const plan = buildScrollGesturePlan({
    direction,
    amount: options?.amount,
    pixels: options?.pixels,
    referenceWidth: size.width,
    referenceHeight: size.height,
  });
  const durationMs = options?.durationMs ?? 300;

  await runAndroidAdb(device, [
    'shell',
    'input',
    'swipe',
    String(plan.x1),
    String(plan.y1),
    String(plan.x2),
    String(plan.y2),
    String(durationMs),
  ]);

  return {
    ...plan,
    ...(options?.durationMs !== undefined ? { durationMs: options.durationMs } : {}),
  };
}

function resolveAndroidUserRotation(orientation: DeviceRotation): string {
  switch (orientation) {
    case 'portrait':
      return '0';
    case 'landscape-left':
      return '1';
    case 'portrait-upside-down':
      return '2';
    case 'landscape-right':
      return '3';
    default:
      throw new AppError('INVALID_ARGS', `Unsupported Android rotation: ${orientation}`);
  }
}

async function assertAndroidShellInputIsAppOwned(
  device: DeviceInfo,
  action: AndroidTextInputAction,
): Promise<void> {
  let state: AndroidKeyboardState;
  try {
    state = await getAndroidKeyboardState(device);
  } catch (error) {
    emitDiagnostic({
      level: 'warn',
      phase: 'android_input_ownership_probe_failed',
      data: {
        action,
        error: error instanceof Error ? error.message : String(error),
      },
    });
    return;
  }
  if (state.inputOwner !== 'ime') return;
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

export async function getAndroidScreenSize(
  device: DeviceInfo,
): Promise<{ width: number; height: number }> {
  const result = await runAndroidAdb(device, ['shell', 'wm', 'size']);
  const match = result.stdout.match(/Physical size:\s*(\d+)x(\d+)/);
  if (!match) throw new AppError('COMMAND_FAILED', 'Unable to read screen size');
  return { width: Number(match[1]), height: Number(match[2]) };
}

const ANDROID_INPUT_TEXT_CHUNK_SIZE = 8;

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
    await runAndroidAdb(device, ['shell', 'input', 'text', encodeAndroidInputText(text)]);
  } catch (error) {
    if (isAndroidInputTextUnsupported(error)) {
      throw unsupportedAndroidShellTextError(text, error);
    }
    throw error;
  }
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

function clampCount(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
