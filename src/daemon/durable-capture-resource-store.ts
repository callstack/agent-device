import fs from 'node:fs';
import path from 'node:path';
import type {
  DurableEnvelopeDecodeOutcome,
  DurableResourceEnvelope,
} from '@agent-device/contracts/durable-resource-envelope';
import { decodeDurableResourceEnvelope } from '@agent-device/capture-kit';
import { withAtomicPublishTempPathSync } from '@agent-device/host-kit/file';
import { openVerifiedFileForRead } from '../utils/verified-file.ts';

export type DurableCaptureResourceRecord<K extends string> =
  | Readonly<{ status: 'missing' }>
  | Readonly<{ status: 'decoded'; envelope: DurableResourceEnvelope<K> }>
  | Readonly<{
      status: 'unreattachable';
      reason: 'descriptor-invalid' | 'descriptor-version-unsupported';
      message: string;
      version?: number;
    }>;

export type DurableCaptureResourceStore<K extends string> = Readonly<{
  resourceKind: K;
  displayName: string;
  resolvePath(sessionDir: string): string;
  read(resourcePath: string): DurableCaptureResourceRecord<K>;
  write(resourcePath: string, envelope: DurableResourceEnvelope<K>): void;
  list(sessionsDir: string): string[];
}>;

export function createDurableCaptureResourceStore<K extends string>(
  options: Readonly<{
    resourceKind: K;
    fileName: string;
    displayName: string;
  }>,
): DurableCaptureResourceStore<K> {
  assertFileName(options.fileName);
  const resolvePath = (sessionDir: string): string => path.join(sessionDir, options.fileName);
  return Object.freeze({
    resourceKind: options.resourceKind,
    displayName: options.displayName,
    resolvePath,
    read(resourcePath: string): DurableCaptureResourceRecord<K> {
      let descriptor: number | undefined;
      let value: unknown;
      try {
        descriptor = openVerifiedFileForRead(resourcePath);
        if (descriptor === undefined) return { status: 'missing' };
        value = JSON.parse(fs.readFileSync(descriptor, 'utf8')) as unknown;
      } catch (error) {
        if (isMissingFile(error)) return { status: 'missing' };
        return invalidRecord(errorMessage(error, options.displayName));
      } finally {
        if (descriptor !== undefined) fs.closeSync(descriptor);
      }
      return narrowEnvelope(decodeDurableResourceEnvelope(value), options.resourceKind);
    },
    write(resourcePath: string, envelope: DurableResourceEnvelope<K>): void {
      const directory = path.dirname(resourcePath);
      fs.mkdirSync(directory, { recursive: true });
      withAtomicPublishTempPathSync(resourcePath, (temporaryPath) => {
        let descriptor: number | undefined;
        try {
          assertSafeDestination(resourcePath, options.displayName);
          descriptor = fs.openSync(temporaryPath, 'wx', 0o600);
          fs.writeFileSync(descriptor, `${JSON.stringify(envelope)}\n`, 'utf8');
          fs.fsyncSync(descriptor);
          fs.closeSync(descriptor);
          descriptor = undefined;
          assertSafeDestination(resourcePath, options.displayName);
          fs.renameSync(temporaryPath, resourcePath);
          syncDirectoryBestEffort(directory);
        } finally {
          if (descriptor !== undefined) fs.closeSync(descriptor);
        }
      });
    },
    list(sessionsDir: string): string[] {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(sessionsDir, { withFileTypes: true });
      } catch {
        return [];
      }
      return entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => resolvePath(path.join(sessionsDir, entry.name)))
        .filter(pathEntryExistsWithoutFollowing)
        .sort();
    },
  });
}

function narrowEnvelope<K extends string>(
  decoded: DurableEnvelopeDecodeOutcome,
  resourceKind: K,
): DurableCaptureResourceRecord<K> {
  if (decoded.status !== 'decoded') return decoded;
  if (decoded.envelope.resourceKind !== resourceKind) {
    return invalidRecord(
      `Expected ${resourceKind} resource record, received ${decoded.envelope.resourceKind}`,
    );
  }
  return { status: 'decoded', envelope: decoded.envelope as DurableResourceEnvelope<K> };
}

function assertFileName(fileName: string): void {
  if (fileName.length === 0 || path.basename(fileName) !== fileName) {
    throw new TypeError('Durable capture resource fileName must be one file name');
  }
}

function assertSafeDestination(resourcePath: string, displayName: string): void {
  let destination: fs.Stats;
  try {
    destination = fs.lstatSync(resourcePath);
  } catch (error) {
    if (isMissingFile(error)) return;
    throw error;
  }
  if (destination.isSymbolicLink()) {
    throw new Error(`Refusing to replace a ${displayName.toLowerCase()} resource symbolic link`);
  }
  if (!destination.isFile()) {
    throw new Error(
      `Refusing to replace a ${displayName.toLowerCase()} resource that is not a regular file`,
    );
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

function invalidRecord<K extends string>(message: string): DurableCaptureResourceRecord<K> {
  return { status: 'unreattachable', reason: 'descriptor-invalid', message };
}

function syncDirectoryBestEffort(directory: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(directory, 'r');
    fs.fsyncSync(descriptor);
  } catch {
    // Atomic rename is the correctness boundary; directory fsync support varies by filesystem.
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
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

function errorMessage(error: unknown, displayName: string): string {
  return error instanceof Error ? error.message : `${displayName} resource record is invalid`;
}
