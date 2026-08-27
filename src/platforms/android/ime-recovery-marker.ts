import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { normalizeError } from '@agent-device/kernel/errors';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';

// Device-scoped pending-recovery markers, one file per switched device, in the daemon state dir.
// The marker is separate from IME mechanics so startup can establish evidence before it loads the
// Android implementation or probes adb.
const PENDING_RECOVERY_DIR = 'android-test-ime-pending';
const MARKER_VERSION = 1;

type AndroidTestImeRecoveryMarker = Readonly<{
  version: typeof MARKER_VERSION;
  serial: string;
}>;

function pendingRecoveryDir(stateDir: string): string {
  return path.join(stateDir, PENDING_RECOVERY_DIR);
}

function pendingRecoveryFile(stateDir: string, serial: string): string {
  return path.join(pendingRecoveryDir(stateDir), encodeURIComponent(serial));
}

export async function writeAndroidTestImeRecoveryMarker(
  stateDir: string,
  serial: string,
): Promise<boolean> {
  let temporaryPath: string | undefined;
  let temporaryHandle: Awaited<ReturnType<typeof fs.open>> | undefined;
  let markerPath: string | undefined;
  let wroteMarker = false;
  try {
    const dir = pendingRecoveryDir(stateDir);
    markerPath = pendingRecoveryFile(stateDir, serial);
    await fs.mkdir(dir, { recursive: true });
    // A valid marker already protects this exact device. Keep it rather than replacing it so a
    // failed activation cannot erase the only startup-recovery evidence for an existing owner.
    if ((await readAndroidTestImeRecoveryMarker(markerPath))?.serial === serial) return true;
    temporaryPath = path.join(dir, `.${encodeURIComponent(serial)}.${randomUUID()}.tmp`);
    const marker: AndroidTestImeRecoveryMarker = { version: MARKER_VERSION, serial };
    // Sync the temp record before publish. The temp-write/rename transition means startup sees
    // either a complete validated marker or no marker at all — never a partially written serial
    // that could select an arbitrary device.
    temporaryHandle = await fs.open(temporaryPath, 'wx', 0o600);
    await temporaryHandle.writeFile(`${JSON.stringify(marker)}\n`, 'utf8');
    await temporaryHandle.sync();
    await temporaryHandle.close();
    temporaryHandle = undefined;
    await fs.rename(temporaryPath, markerPath);
    temporaryPath = undefined;
    wroteMarker = true;
    await syncDirectoryBestEffort(dir);
    if ((await readAndroidTestImeRecoveryMarker(markerPath))?.serial !== serial) {
      throw new Error('Android test IME marker read-back did not match the requested device.');
    }
    return true;
  } catch (error) {
    if (temporaryHandle) await temporaryHandle.close().catch(() => {});
    if (temporaryPath) await fs.rm(temporaryPath, { force: true }).catch(() => {});
    // A valid marker returned above is never replaced. If this call created an unconfirmed marker,
    // remove only that partial record; a previous valid marker is intentionally untouched.
    if (wroteMarker && markerPath) await fs.rm(markerPath, { force: true }).catch(() => {});
    emitDiagnostic({
      level: 'debug',
      phase: 'android_test_ime_marker_write_failed',
      data: { stateDir, serial, error: normalizeError(error).message },
    });
    return false;
  }
}

async function syncDirectoryBestEffort(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(directory, 'r');
    await handle.sync();
  } catch {
    // Atomic rename remains the correctness boundary on filesystems that cannot sync a directory.
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

export async function clearAndroidTestImeRecoveryMarker(
  stateDir: string,
  serial: string,
): Promise<void> {
  await fs.rm(pendingRecoveryFile(stateDir, serial), { force: true }).catch(() => {});
}

/**
 * Reads only validated durable recovery descriptors. Startup uses this as its evidence gate before
 * dynamically loading Android IME mechanics or issuing an adb probe.
 */
export async function readAndroidTestImeRecoveryMarkers(stateDir: string): Promise<string[]> {
  let files: string[];
  try {
    files = await fs.readdir(pendingRecoveryDir(stateDir));
  } catch {
    return [];
  }
  const serials: string[] = [];
  for (const file of files) {
    try {
      const markerPath = path.join(pendingRecoveryDir(stateDir), file);
      const marker = await readAndroidTestImeRecoveryMarker(markerPath);
      // Reject torn/corrupt descriptors and prevent a crafted file name from selecting a different
      // serial than the durable record it is supposed to describe.
      if (marker && pendingRecoveryFile(stateDir, marker.serial) === markerPath)
        serials.push(marker.serial);
    } catch {
      // Torn/unreadable marker; ignore it.
    }
  }
  return [...new Set(serials)].sort();
}

async function readAndroidTestImeRecoveryMarker(
  markerPath: string,
): Promise<AndroidTestImeRecoveryMarker | undefined> {
  try {
    return parseAndroidTestImeRecoveryMarker(await fs.readFile(markerPath, 'utf8'));
  } catch {
    return undefined;
  }
}

function parseAndroidTestImeRecoveryMarker(raw: string): AndroidTestImeRecoveryMarker | undefined {
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const marker = value as Record<string, unknown>;
    return marker.version === MARKER_VERSION &&
      typeof marker.serial === 'string' &&
      marker.serial.length > 0
      ? { version: MARKER_VERSION, serial: marker.serial }
      : undefined;
  } catch {
    return undefined;
  }
}
