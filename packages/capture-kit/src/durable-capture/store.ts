import fs from 'node:fs';
import path from 'node:path';
import type {
  DurableEnvelopeDecodeOutcome,
  DurableResourceEnvelope,
} from '@agent-device/contracts/durable-resource-envelope';
import { openVerifiedFileForRead, publishDurableFileSync } from '@agent-device/host-kit/file';
import { decodeDurableResourceEnvelope } from '../durable-resource-envelope.ts';

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
      publishDurableFileSync({
        destination: resourcePath,
        contents: `${JSON.stringify(envelope)}\n`,
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
