import { ANDROID_TEXT_CHANNEL_REASONS } from '@agent-device/contracts/command';
import { AppError } from '@agent-device/kernel/errors';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { isCommandTimeoutError } from '@agent-device/host-kit/command';
import { sleep } from '@agent-device/host-kit/retry';
import {
  readAndroidHelperManifestInteger,
  readAndroidHelperManifestLiteral,
  readAndroidHelperManifestSha256,
  readAndroidHelperManifestString,
  type AndroidHelperInstallDecision,
  type AndroidImeHelperArtifact,
  type AndroidImeHelperManifest,
} from './helper-artifacts.ts';
import type { ShellWord } from '@agent-device/kernel/device-shell';
import { androidAdbResultError, discloseAdbInputDispatch } from './adb-failure.ts';
import { runAdbShell } from './adb-executor.ts';
import type { AndroidAdbExecutor, AndroidAdbProvider } from './adb-transport.ts';
import { requireAndroidAdbHost } from './adb-host.ts';

// Headless InputMethodService, driven over `adb shell am broadcast` (not `am instrument`).

const HELPER_LABEL = 'Android IME helper';
const ANDROID_IME_HELPER_NAME = 'android-ime-helper';
const ANDROID_IME_HELPER_PACKAGE = 'com.callstack.agentdevice.imehelper';
const ANDROID_IME_HELPER_SERVICE = 'com.callstack.agentdevice.imehelper/.TestInputMethodService';
const ANDROID_IME_HELPER_PROTOCOL = 'android-ime-helper-v2';

// Stable service-component id, matched literally by the manifest parser. Exported so the restore
// lifecycle can compare the device's active IME without reading the packaged artifact from disk.
export const ANDROID_IME_HELPER_SERVICE_COMPONENT = ANDROID_IME_HELPER_SERVICE;
const ANDROID_IME_HELPER_INSTALL_TIMEOUT_MS = 30_000;
const ANDROID_IME_HELPER_BROADCAST_TIMEOUT_MS = 10_000;
const ANDROID_IME_HELPER_REGISTRATION_TIMEOUT_MS = 5_000;
const ANDROID_IME_HELPER_REGISTRATION_POLL_MS = 100;

const ACTION_INPUT_TEXT_B64 = 'com.callstack.agentdevice.imehelper.ACTION_INPUT_TEXT_B64';
const ACTION_CLEAR_TEXT = 'com.callstack.agentdevice.imehelper.ACTION_CLEAR_TEXT';

// Finite result-code set mirrored by the helper (TestInputMethodService). All non-zero: the
// transport prints result=0 when no receiver answered, so 0 is never a valid ack. An ack proves
// attempted dispatch (and the commitText return), not final field content — fill keeps its single
// read-back owner. Result data carries codes/lengths only, never user text.
const IME_RESULT_COMMITTED = 1;
const IME_RESULT_COMMIT_RETURNED_FALSE = 2;
const IME_RESULT_NO_INPUT_CONNECTION = 3;
const IME_RESULT_REJECTED_PAYLOAD = 4;
const IME_RESULT_PROTOCOL_MISMATCH = 5;

/**
 * Declared per-dispatch payload bound, mirrored by the helper: a base64 extra of at most 64_000
 * chars, i.e. at most 48_000 UTF-8 bytes decoded. Measured on-device (Pixel 7, API 36): payloads up
 * to 64_000 chars are delivered and committed, and the adb-shell channel itself breaks between
 * 65_000 and 66_000 chars, so this declared bound is the binding one. The host chunks below it on
 * code-point boundaries; the helper rejects (never truncates) anything above it.
 */
const IME_HELPER_MAX_BASE64_LENGTH = 64_000;
const IME_HELPER_MAX_UTF8_BYTES = (IME_HELPER_MAX_BASE64_LENGTH / 4) * 3;

/** What the helper's ordered broadcast acknowledgement reported for one dispatch. */
export type AndroidImeHelperDispatchOutcome = Readonly<
  | { kind: 'committed'; attemptedUtf16: number }
  | { kind: 'commit-returned-false'; attemptedUtf16: number }
  | { kind: 'no-input-connection' }
  | { kind: 'rejected-payload'; detail: string }
  | { kind: 'protocol-mismatch' }
  // `no-receiver`: the broadcast completed and no receiver answered (result=0), as a helper from
  // before the acknowledgement protocol does. `unreadable-ack`: no completion line, or one the
  // host cannot read, which says nothing about the installed helper.
  | { kind: 'no-ack'; cause: 'no-receiver' | 'unreadable-ack' }
>;

type AndroidImeBroadcastResult = Readonly<{ resultCode: number; resultData: string }>;

/**
 * Parses `am broadcast`'s completion line, e.g. `Broadcast completed: result=1, data="utf16=9",
 * extras: Bundle[...]`. Returns null when the line is absent — the process exit code alone is not
 * evidence: it is 0 whether or not any receiver answered.
 */
function parseAndroidImeBroadcastResult(stdout: string): AndroidImeBroadcastResult | null {
  const match = /Broadcast completed: result=(-?\d+)(?:, data="((?:[^"\\]|\\.)*)")?/.exec(stdout);
  if (!match) return null;
  const resultCode = Number.parseInt(match[1] ?? '0', 10);
  const rawData = match[2] ?? '';
  return {
    resultCode,
    resultData: rawData.replaceAll(String.raw`\"`, '"').replaceAll(String.raw`\\`, '\\'),
  };
}

function readAttemptedUtf16(resultData: string): number | null {
  const match = /^utf16=(\d+)$/.exec(resultData);
  return match ? Number.parseInt(match[1] ?? '', 10) : null;
}

function classifyAndroidImeBroadcastResult(
  result: AndroidImeBroadcastResult | null,
): AndroidImeHelperDispatchOutcome {
  const unreadable = { kind: 'no-ack', cause: 'unreadable-ack' } as const;
  if (!result) return unreadable;
  if (result.resultCode === 0) return { kind: 'no-ack', cause: 'no-receiver' };
  switch (result.resultCode) {
    case IME_RESULT_COMMITTED: {
      const attemptedUtf16 = readAttemptedUtf16(result.resultData);
      return attemptedUtf16 === null ? unreadable : { kind: 'committed', attemptedUtf16 };
    }
    case IME_RESULT_COMMIT_RETURNED_FALSE: {
      const attemptedUtf16 = readAttemptedUtf16(result.resultData);
      return attemptedUtf16 === null
        ? unreadable
        : { kind: 'commit-returned-false', attemptedUtf16 };
    }
    case IME_RESULT_NO_INPUT_CONNECTION:
      return { kind: 'no-input-connection' };
    case IME_RESULT_REJECTED_PAYLOAD:
      return { kind: 'rejected-payload', detail: result.resultData || 'rejected' };
    case IME_RESULT_PROTOCOL_MISMATCH:
      return { kind: 'protocol-mismatch' };
    default:
      return unreadable;
  }
}

/**
 * The IME helper this device should use: a provider that ships its own helper supplies it on the
 * adb provider, exactly as it may for the snapshot helper; otherwise the npm-bundled artifact.
 */
export async function selectAndroidImeHelperArtifact(
  adbProvider: AndroidAdbProvider,
): Promise<AndroidImeHelperArtifact> {
  return adbProvider.imeHelperArtifact ?? (await resolveAndroidImeHelperArtifact());
}

/** The npm-bundled artifact. */
export async function resolveAndroidImeHelperArtifact(): Promise<AndroidImeHelperArtifact> {
  return await requireAndroidAdbHost().resolveHelperArtifact({
    helperDirName: 'ime-helper',
    manifestFileName: (version) => `agent-device-android-ime-helper-${version}.manifest.json`,
    parseManifest: parseAndroidImeHelperManifest,
    unavailableMessage:
      'Android test IME text entry requires the bundled Android IME helper artifact, but it was not found or could not be read',
  });
}

// readAndroidHelperManifestXxx already prepend "Android " to this label.
const MANIFEST_HELPER_LABEL = 'IME helper';

function parseAndroidImeHelperManifest(value: unknown): AndroidImeHelperManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppError('INVALID_ARGS', 'Android IME helper manifest must be an object.');
  }
  const record = value as Record<string, unknown>;
  return {
    name: readAndroidHelperManifestLiteral(
      record.name,
      'name',
      ANDROID_IME_HELPER_NAME,
      MANIFEST_HELPER_LABEL,
    ),
    version: readAndroidHelperManifestString(record.version, 'version', MANIFEST_HELPER_LABEL),
    assetName: readAndroidHelperManifestString(
      record.assetName,
      'assetName',
      MANIFEST_HELPER_LABEL,
    ),
    sha256: readAndroidHelperManifestSha256(record.sha256, MANIFEST_HELPER_LABEL),
    packageName: readAndroidHelperManifestLiteral(
      record.packageName,
      'packageName',
      ANDROID_IME_HELPER_PACKAGE,
      MANIFEST_HELPER_LABEL,
    ),
    versionCode: readAndroidHelperManifestInteger(
      record.versionCode,
      'versionCode',
      MANIFEST_HELPER_LABEL,
    ),
    serviceComponent: readAndroidHelperManifestLiteral(
      record.serviceComponent,
      'serviceComponent',
      ANDROID_IME_HELPER_SERVICE,
      MANIFEST_HELPER_LABEL,
    ),
    broadcastProtocol: readAndroidHelperManifestLiteral(
      record.broadcastProtocol,
      'broadcastProtocol',
      ANDROID_IME_HELPER_PROTOCOL,
      MANIFEST_HELPER_LABEL,
    ),
  };
}

const installedImeHelpers = new Set<string>();

export async function ensureAndroidImeHelper(options: {
  adb: AndroidAdbExecutor;
  adbProvider: AndroidAdbProvider;
  artifact: AndroidImeHelperArtifact;
  deviceKey: string;
}): Promise<AndroidHelperInstallDecision> {
  const decision = await requireAndroidAdbHost().ensureHelperInstalled(
    {
      cache: installedImeHelpers,
      installTimeoutMs: ANDROID_IME_HELPER_INSTALL_TIMEOUT_MS,
      helperLabel: HELPER_LABEL,
    },
    options,
  );
  if (decision.installed) {
    await waitForAndroidImeRegistration(options.adb, options.artifact.manifest.serviceComponent);
  }
  return decision;
}

// `adb install` returns before the input method manager registers the new service, and until it
// does, `ime enable` and `ime set` reject it as unknown. The wait is best-effort: once its budget
// runs out, the activation's read-back reports the refusal.
async function waitForAndroidImeRegistration(
  adb: AndroidAdbExecutor,
  serviceComponent: string,
): Promise<void> {
  const deadline = Date.now() + ANDROID_IME_HELPER_REGISTRATION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const result = await runAdbShell(adb, ['ime', 'list', '-a', '-s'], {
        allowFailure: true,
        timeoutMs: Math.max(1, deadline - Date.now()),
      });
      if (result.stdout.split(/\r?\n/).includes(serviceComponent)) return;
    } catch (error) {
      if (isCommandTimeoutError(error)) return;
      throw error;
    }
    await sleep(ANDROID_IME_HELPER_REGISTRATION_POLL_MS);
  }
}

/**
 * @internal Test isolation hook for process-global IME helper install cache.
 */
export function resetAndroidImeHelperInstallCache(): void {
  installedImeHelpers.clear();
}

export function getAndroidImeHelperDeviceKey(device: DeviceInfo): string {
  return `${device.platform}:${device.id}`;
}

/**
 * Whether a device's active input method IS this helper. The batch broadcast channel below works
 * whenever that holds — which is not the same as "this daemon process switched the IME". A crashed
 * run, a second daemon on the same emulator, or an `open --no-test-ime` onto a device that already
 * carries the helper all leave the channel available with an empty activation cache.
 */
export function isAndroidImeHelperPackage(packageName: string | undefined): packageName is string {
  return packageName === ANDROID_IME_HELPER_PACKAGE;
}

// --- Broadcast text-entry channel -----------------------------------------------------------
// The IME's receiver requires the WRITE_SECURE_SETTINGS sender permission, which adb shell holds
// but a co-installed third-party app cannot — that permission gate (not the transport) is the
// trust boundary. Broadcasts are package-scoped (`-p`) to the in-process dynamic receiver.

export async function sendAndroidImeHelperText(
  adb: AndroidAdbExecutor,
  packageName: string,
  text: string,
): Promise<AndroidImeHelperDispatchOutcome> {
  const payloadBase64 = Buffer.from(text, 'utf8').toString('base64');
  return await sendAndroidImeHelperBroadcast(adb, packageName, ACTION_INPUT_TEXT_B64, {
    text: payloadBase64,
  });
}

export async function clearAndroidImeHelperText(
  adb: AndroidAdbExecutor,
  packageName: string,
): Promise<AndroidImeHelperDispatchOutcome> {
  return await sendAndroidImeHelperBroadcast(adb, packageName, ACTION_CLEAR_TEXT, {});
}

/**
 * Splits text into code-point-safe dispatch chunks, each within the helper's declared per-broadcast
 * byte bound (base64 of the chunk stays under 64_000 chars). Never splits a surrogate pair; the
 * total payload stays unbounded — oversized text is dispatched as ordered chunks, not truncated.
 */
export function chunkAndroidImeHelperText(text: string): string[] {
  const codePoints = Array.from(text);
  const chunks: string[] = [];
  let current = '';
  let currentBytes = 0;
  for (const codePoint of codePoints) {
    const bytes = Buffer.byteLength(codePoint, 'utf8');
    if (currentBytes + bytes > IME_HELPER_MAX_UTF8_BYTES && current.length > 0) {
      chunks.push(current);
      current = '';
      currentBytes = 0;
    }
    current += codePoint;
    currentBytes += bytes;
  }
  chunks.push(current);
  return chunks;
}

/**
 * Sends one code-point-safe chunk and requires a committed acknowledgement whose attempted UTF-16
 * length matches the request — a shorter ack would mean silent truncation. Throws a typed error
 * otherwise; result details carry codes and lengths only.
 */
export async function sendAndroidImeHelperTextCommitted(
  adb: AndroidAdbExecutor,
  packageName: string,
  text: string,
): Promise<void> {
  const outcome = await sendAndroidImeHelperText(adb, packageName, text);
  assertCommittedOutcome(outcome, text.length);
}

/** Clear whose acknowledgement must report an attempted (empty) commit, same strictness as text. */
export async function clearAndroidImeHelperTextCommitted(
  adb: AndroidAdbExecutor,
  packageName: string,
): Promise<void> {
  const outcome = await clearAndroidImeHelperText(adb, packageName);
  assertCommittedOutcome(outcome, 0);
}

function assertCommittedOutcome(
  outcome: AndroidImeHelperDispatchOutcome,
  requestedUtf16: number,
): asserts outcome is { kind: 'committed'; attemptedUtf16: number } {
  if (outcome.kind === 'committed' && outcome.attemptedUtf16 === requestedUtf16) return;
  throw new AppError(
    'COMMAND_FAILED',
    'Android test IME helper dispatch was not acknowledged as committed.',
    {
      backend: 'test-ime',
      reason:
        outcome.kind === 'no-ack'
          ? ANDROID_TEXT_CHANNEL_REASONS.imeHelperNoAck.reason
          : ANDROID_TEXT_CHANNEL_REASONS.imeHelperDispatchRejected.reason,
      dispatchKind: outcome.kind,
      ...(outcome.kind === 'no-ack'
        ? {
            ackCause: outcome.cause,
            hint:
              outcome.cause === 'no-receiver'
                ? 'Reinstall a current bundled or provider IME helper and reopen the session.'
                : 'The helper acknowledgement did not arrive or could not be read. Retry the command. If it repeats, check the adb connection.',
          }
        : {}),
      ...('attemptedUtf16' in outcome ? { attemptedUtf16: outcome.attemptedUtf16 } : {}),
      ...('detail' in outcome ? { detail: outcome.detail } : {}),
      requestedUtf16,
    },
  );
}

async function sendAndroidImeHelperBroadcast(
  adb: AndroidAdbExecutor,
  packageName: string,
  action: string,
  extras: Record<string, string>,
): Promise<AndroidImeHelperDispatchOutcome> {
  const words: ShellWord[] = ['am', 'broadcast', '-p', packageName, '-a', action];
  words.push('--es', 'protocol', ANDROID_IME_HELPER_PROTOCOL);
  for (const [key, value] of Object.entries(extras)) {
    words.push('--es', key, value);
  }
  try {
    const result = await runAdbShell(adb, words, {
      allowFailure: true,
      timeoutMs: ANDROID_IME_HELPER_BROADCAST_TIMEOUT_MS,
    });
    if (result.exitCode !== 0) {
      throw androidAdbResultError('Android IME helper broadcast failed', result, {
        action,
        packageName,
      });
    }
    return classifyAndroidImeBroadcastResult(parseAndroidImeBroadcastResult(result.stdout));
  } catch (error) {
    throw discloseAdbInputDispatch(error);
  }
}
