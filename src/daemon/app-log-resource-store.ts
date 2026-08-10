import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  type DurableEnvelopeDecodeOutcome,
  type DurableResourceEnvelope,
} from '@agent-device/contracts/platform';
import { decodeDurableResourceEnvelope } from '@agent-device/capture-kit';
import { openVerifiedFileForRead } from '../utils/verified-file.ts';

const APP_LOG_RESOURCE_FILENAME = 'app-log.resource.json';

export type AppLogResourceRecordRead =
  | Readonly<{ status: 'missing' }>
  | Readonly<{ status: 'decoded'; envelope: DurableResourceEnvelope<'app-log'> }>
  | Readonly<{
      status: 'unreattachable';
      reason: 'descriptor-invalid' | 'descriptor-version-unsupported';
      message: string;
      version?: number;
    }>;

export function resolveAppLogResourcePath(sessionDir: string): string {
  return path.join(sessionDir, APP_LOG_RESOURCE_FILENAME);
}

export function readAppLogResourceRecord(resourcePath: string): AppLogResourceRecordRead {
  let fd: number | undefined;
  let value: unknown;
  try {
    fd = openVerifiedFileForRead(resourcePath);
    if (fd === undefined) return { status: 'missing' };
    value = JSON.parse(fs.readFileSync(fd, 'utf8')) as unknown;
  } catch (error) {
    if (isMissingFile(error)) return { status: 'missing' };
    return invalidResourceRecord(
      error instanceof Error ? error.message : 'App-log resource record is invalid',
    );
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }

  const decoded = decodeDurableResourceEnvelope(value);
  return narrowAppLogEnvelope(decoded);
}

export function writeAppLogResourceRecord(
  resourcePath: string,
  envelope: DurableResourceEnvelope<'app-log'>,
): void {
  const dir = path.dirname(resourcePath);
  fs.mkdirSync(dir, { recursive: true });
  const temporaryPath = path.join(
    dir,
    `.${path.basename(resourcePath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  let fd: number | undefined;
  try {
    assertSafeResourceDestination(resourcePath);
    fd = fs.openSync(temporaryPath, 'wx', 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(envelope)}\n`, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    assertSafeResourceDestination(resourcePath);
    fs.renameSync(temporaryPath, resourcePath);
    syncDirectoryBestEffort(dir);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try {
      fs.rmSync(temporaryPath, { force: true });
    } catch {}
  }
}

export function listAppLogResourcePaths(sessionsDir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(sessionsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => resolveAppLogResourcePath(path.join(sessionsDir, entry.name)))
    .filter(pathEntryExistsWithoutFollowing)
    .sort();
}

function assertSafeResourceDestination(resourcePath: string): void {
  let destination: fs.Stats;
  try {
    destination = fs.lstatSync(resourcePath);
  } catch (error) {
    if (isMissingFile(error)) return;
    throw error;
  }
  if (destination.isSymbolicLink()) {
    throw new Error('Refusing to replace an app-log resource symbolic link');
  }
  if (!destination.isFile()) {
    throw new Error('Refusing to replace an app-log resource that is not a regular file');
  }
}

function pathEntryExistsWithoutFollowing(resourcePath: string): boolean {
  try {
    fs.lstatSync(resourcePath);
    return true;
  } catch (error) {
    return !isMissingFile(error);
  }
}

function invalidResourceRecord(message: string): AppLogResourceRecordRead {
  return {
    status: 'unreattachable',
    reason: 'descriptor-invalid',
    message,
  };
}

function narrowAppLogEnvelope(decoded: DurableEnvelopeDecodeOutcome): AppLogResourceRecordRead {
  if (decoded.status !== 'decoded') return decoded;
  if (decoded.envelope.resourceKind !== 'app-log') {
    return {
      status: 'unreattachable',
      reason: 'descriptor-invalid',
      message: `Expected app-log resource record, received ${decoded.envelope.resourceKind}`,
    };
  }
  return {
    status: 'decoded',
    envelope: decoded.envelope as DurableResourceEnvelope<'app-log'>,
  };
}

function syncDirectoryBestEffort(dir: string): void {
  let fd: number | undefined;
  try {
    fd = fs.openSync(dir, 'r');
    fs.fsyncSync(fd);
  } catch {
    // Atomic rename is the correctness boundary. Directory fsync support differs
    // by host filesystem, so durability hardening remains best effort here.
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function isMissingFile(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}
