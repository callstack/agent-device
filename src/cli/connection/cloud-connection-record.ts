import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  acquireProcessLock,
  lstatIfPresent,
  openVerifiedFileForRead,
  publishFileSync,
  tryAcquireProcessLock,
  withProcessLock,
} from '@agent-device/host-kit/file';
import { readCurrentOwnerIdentity } from '@agent-device/host-kit/process';
import { AppError, type ReasonTable } from '@agent-device/kernel/errors';
import {
  readRemoteConnectionState,
  type CloudSessionBinding,
  type RemoteConnectionState,
} from '@agent-device/remote/remote-connection-state';
import type { CloudSessionRequest } from './cloud-session-api.ts';

export const CLOUD_CONNECTION_REASONS = {
  // A cloud credential directory or file is unsafe to reuse.
  credentialStoreUnsafe: { reason: 'cloud_credential_store_unsafe' },
  // The saved cloud connection record cannot be read safely.
  recordUnreadable: { reason: 'cloud_connection_record_unreadable' },
  // The saved cloud connection belongs to another named session.
  sessionMismatch: { reason: 'cloud_connection_session_mismatch' },
  // A pending cloud request must finish or end before its options change.
  pendingConflict: { reason: 'cloud_connect_pending_conflict' },
  // A connection operation is in progress for the session.
  busy: { reason: 'connection_busy', commands: ['connect', 'disconnect'] },
  // The named session is owned by a cloud connection.
  ownsSession: { reason: 'cloud_connection_owns_session' },
  // The named cloud connection changed before the operation could complete.
  changed: { reason: 'cloud_connection_changed' },
  // The cloud session passed its deadline.
  expired: { reason: 'cloud_connection_expired' },
  // The cloud did not confirm cleanup after attachment failed.
  rollbackFailed: { reason: 'cloud_connect_rollback_failed' },
  // The cloud returned a different session ID for the same request.
  idChanged: { reason: 'cloud_session_id_changed' },
} as const satisfies ReasonTable<'cloud sessions'>;

export type ConnectionLocation = { stateDir: string; session: string };

export type CloudConnectionRecord = {
  session: string;
  generation: string;
  phase: 'pending' | 'committed' | 'closing';
  origin: string;
  fingerprint: string;
  accepts?: CloudSessionRequest['accepts'];
  id?: string;
  deadlineAt?: string;
  hostedLeaseId?: string;
  brokerReleased?: true;
};

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function cloudConnectionDir({ stateDir, session }: ConnectionLocation): string {
  return path.join(stateDir, 'cloud-connections', hash(session));
}

export async function withConnectionLock<T>(
  stateDir: string,
  session: string,
  task: () => Promise<T>,
  onContention?: () => void,
): Promise<T> {
  return await withProcessLock({
    acquire: () =>
      acquireProcessLock({
        ...connectionLockOptions({ stateDir, session }),
        timeoutMs: 180_000,
        onContention,
      }),
    task,
  });
}

export async function tryWithConnectionLock(
  location: ConnectionLocation,
  task: () => Promise<void> | void,
): Promise<void> {
  const lock = tryAcquireProcessLock(connectionLockOptions(location));
  if (lock.status !== 'acquired') return;
  await withProcessLock({
    acquire: async () => lock.acquisition.release,
    task: async () => await task(),
  });
}

export function refuseContendedConnection(
  location: ConnectionLocation,
  command: 'connect' | 'disconnect',
  claimedConnection?: RemoteConnectionState | null,
): void {
  const record = readCloudConnection(location);
  const allocating = record?.phase === 'pending';
  if (!allocating && (record || claimedConnection || readRemoteConnectionState(location))) return;
  const reason = allocating
    ? cloudAllocationContentionReason(command)
    : CLOUD_CONNECTION_REASONS.busy.reason;
  throw new AppError('COMMAND_FAILED', 'A connection operation is in progress for this session.', {
    reason,
    retriable: true,
    hint: `Retry ${command} after the other connection operation finishes.`,
  });
}

function cloudAllocationContentionReason(command: 'connect' | 'disconnect') {
  return command === 'connect'
    ? CLOUD_CONNECTION_REASONS.pendingConflict.reason
    : CLOUD_CONNECTION_REASONS.ownsSession.reason;
}

function connectionLockOptions({ stateDir, session }: ConnectionLocation) {
  return {
    lockDirPath: path.join(stateDir, `connection-${hash(session)}.lock`),
    owner: { ...readCurrentOwnerIdentity(), acquiredAtMs: Date.now() },
    description: 'remote connection',
  };
}

export function admitCloudCredentialDirectory(
  location: ConnectionLocation,
  create = false,
): boolean {
  if (!admitCloudStateRoot(location.stateDir)) return false;
  const directory = cloudConnectionDir(location);
  const cloud = path.dirname(directory);
  for (const entry of [cloud, directory]) {
    const status = readCloudDirectory(entry, create);
    if (!status) return false;
    assertOwnedEntry(status, status.isDirectory(), entry === directory ? 0o077 : 0o022);
  }
  return true;
}

function readCloudDirectory(entry: string, create: boolean): fs.Stats | undefined {
  const existing = lstatIfPresent(entry);
  if (existing || !create) return existing;
  try {
    fs.mkdirSync(entry, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  return lstatIfPresent(entry);
}

function admitCloudStateRoot(stateDir: string): boolean {
  let status;
  try {
    status = fs.statSync(stateDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  assertOwnedEntry(status, status.isDirectory(), 0o022);
  return true;
}

function assertOwnedEntry(status: fs.Stats, correctKind: boolean, exposure: number): void {
  if (!correctKind || !isOwnedEntry(status, exposure)) {
    throw cloudConnectionUnavailable(CLOUD_CONNECTION_REASONS.credentialStoreUnsafe.reason);
  }
}

function isOwnedEntry(status: fs.Stats, exposure: number): boolean {
  const uid = process.geteuid?.();
  return uid === undefined || (status.uid === uid && (status.mode & exposure) === 0);
}

function recordPath(location: ConnectionLocation): string {
  return path.join(cloudConnectionDir(location), 'record.json');
}

export function readCloudCredentialJson(file: string): unknown {
  const fd = openVerifiedFileForRead(file);
  if (fd === undefined) return undefined;
  try {
    const status = fs.fstatSync(fd);
    assertOwnedEntry(status, status.isFile(), 0o077);
    return JSON.parse(fs.readFileSync(fd, 'utf8')) as unknown;
  } finally {
    fs.closeSync(fd);
  }
}

function readRecordFile(file: string): CloudConnectionRecord | null {
  return (readCloudCredentialJson(file) ?? null) as CloudConnectionRecord | null;
}

export function readCloudConnection(location: ConnectionLocation): CloudConnectionRecord | null {
  try {
    if (!admitCloudCredentialDirectory(location)) return null;
    const record = readRecordFile(recordPath(location));
    if (!record) return null;
    if (
      typeof record?.generation === 'string' &&
      typeof record.origin === 'string' &&
      typeof record.fingerprint === 'string' &&
      hasValidStoredAccepts(record.accepts) &&
      ['pending', 'committed', 'closing'].includes(record.phase)
    ) {
      assertCloudRecordSession(location, record);
      return record;
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    if (code === 'ENOENT') return null;
    const ioCode =
      code === 'EACCES' || code === 'EPERM' || code === 'EIO' || code === 'ENOTDIR'
        ? code
        : undefined;
    throw cloudConnectionUnavailable(CLOUD_CONNECTION_REASONS.recordUnreadable.reason, ioCode);
  }
  throw cloudConnectionUnavailable(CLOUD_CONNECTION_REASONS.recordUnreadable.reason);
}

function hasValidStoredAccepts(accepts: unknown): boolean {
  return (
    accepts === undefined ||
    (Array.isArray(accepts) &&
      accepts.length > 0 &&
      accepts.every((kind) => kind === 'agent-device-daemon' || kind === 'limrun'))
  );
}

export function assertCloudRecordSession(
  location: ConnectionLocation,
  record: CloudConnectionRecord,
): void {
  if (record.session !== location.session) {
    throw cloudConnectionUnavailable(CLOUD_CONNECTION_REASONS.sessionMismatch.reason);
  }
}

export function writeCloudConnection(
  location: ConnectionLocation,
  record: CloudConnectionRecord,
): void {
  assertCloudRecordSession(location, record);
  if (!admitCloudCredentialDirectory(location, true)) {
    throw cloudConnectionUnavailable(CLOUD_CONNECTION_REASONS.credentialStoreUnsafe.reason);
  }
  publishFileSync({
    destination: recordPath(location),
    contents: JSON.stringify(record),
    mode: 0o600,
  });
}

export function removeCloudConnection(location: ConnectionLocation): void {
  if (admitCloudCredentialDirectory(location)) fs.rmSync(recordPath(location), { force: true });
}

export function prepareCloudConnection(
  session: string,
  request: CloudSessionRequest,
  origin: string,
  pending: CloudConnectionRecord | null,
): CloudConnectionRecord {
  const fingerprint = hash(JSON.stringify(request));
  if (pending) {
    if (
      pending.phase !== 'pending' ||
      pending.origin !== origin ||
      pending.fingerprint !== fingerprint
    ) {
      throw cloudConnectionUnavailable(CLOUD_CONNECTION_REASONS.pendingConflict.reason);
    }
    return pending;
  }
  return {
    session,
    generation: randomUUID(),
    phase: 'pending',
    origin,
    fingerprint,
    accepts: request.accepts,
  };
}

function assertCloudConnectionOwner(
  location: ConnectionLocation,
  generation: string | undefined,
): void {
  if (!generation) {
    if (readCloudConnection(location))
      throw cloudConnectionUnavailable(CLOUD_CONNECTION_REASONS.ownsSession.reason);
    return;
  }
  readCurrentCloudConnection(location, generation);
}

export function readCurrentCloudConnection(
  location: ConnectionLocation,
  generation: string,
): {
  record: CloudConnectionRecord;
  state: RemoteConnectionState;
  binding: CloudSessionBinding;
} {
  const record = readCloudConnection(location);
  const state = readRemoteConnectionState(location);
  const binding = state?.cloudSession;
  if (
    !record ||
    record.phase !== 'committed' ||
    record.generation !== generation ||
    state?.session !== location.session ||
    !binding ||
    binding.generation !== generation ||
    binding.id !== record.id
  ) {
    throw cloudConnectionUnavailable(CLOUD_CONNECTION_REASONS.changed.reason);
  }
  assertCloudConnectionDeadline(location, record, binding.transport);
  return { record, state, binding };
}

function assertCloudConnectionDeadline(
  location: ConnectionLocation,
  record: CloudConnectionRecord,
  transport: 'agent-device-daemon' | 'limrun',
): void {
  if (isExpired(record)) {
    if (transport === 'agent-device-daemon') removeCloudAttachment(location);
    throw cloudConnectionUnavailable(CLOUD_CONNECTION_REASONS.expired.reason);
  }
}

function isExpired(record: CloudConnectionRecord): boolean {
  return record.deadlineAt !== undefined && Date.parse(record.deadlineAt) <= Date.now();
}

export async function cleanExpiredCloudAttachments(
  stateDir: string,
  retireExpiredDaemon: (location: ConnectionLocation, generation: string) => Promise<void>,
): Promise<void> {
  const root = path.join(stateDir, 'cloud-connections');
  const status = lstatIfPresent(root);
  if (
    !status ||
    !admitCloudStateRoot(stateDir) ||
    !status.isDirectory() ||
    !isOwnedEntry(status, 0o022)
  )
    return;
  for (const entry of readCloudConnectionDirectory(root)) {
    if (!entry.isDirectory()) continue;
    const location = readExpiredAttachmentLocation(stateDir, path.join(root, entry.name));
    if (!location) continue;
    await tryWithConnectionLock(location, async () => {
      const current = readCloudConnection(location);
      if (!current || !isExpired(current)) return;
      const binding = readRemoteConnectionState(location)?.cloudSession;
      const usesRemoteDaemon =
        binding?.transport === 'agent-device-daemon' &&
        binding.generation === current.generation &&
        binding.id === current.id;
      const retired =
        usesRemoteDaemon ||
        (await retireExpiredDaemon(location, current.generation).then(
          () => true,
          () => false,
        ));
      if (retired) removeCloudAttachment(location);
    });
  }
}

function readCloudConnectionDirectory(root: string): fs.Dirent[] {
  try {
    return fs.readdirSync(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

function readExpiredAttachmentLocation(
  stateDir: string,
  dir: string,
): ConnectionLocation | undefined {
  const status = lstatIfPresent(dir);
  if (
    !status?.isDirectory() ||
    !isOwnedEntry(status, 0o077) ||
    !lstatIfPresent(path.join(dir, 'attachment.json'))
  )
    return undefined;
  let record: CloudConnectionRecord | null;
  try {
    record = readRecordFile(path.join(dir, 'record.json'));
  } catch {
    return undefined;
  }
  if (typeof record?.session !== 'string' || !isExpired(record)) return undefined;
  const location = { stateDir, session: record.session };
  return cloudConnectionDir(location) === dir ? location : undefined;
}

export function cloudAttachmentPath(location: ConnectionLocation): string {
  return path.join(cloudConnectionDir(location), 'attachment.json');
}

export function removeCloudAttachment(location: ConnectionLocation): void {
  if (admitCloudCredentialDirectory(location))
    fs.rmSync(cloudAttachmentPath(location), { force: true });
}

export async function withCloudConnectionOwner<T>(
  location: ConnectionLocation,
  generation: string | undefined,
  task: () => Promise<T> | T,
): Promise<T> {
  return await withConnectionLock(
    location.stateDir,
    location.session,
    async () => {
      assertCloudConnectionOwner(location, generation);
      return await task();
    },
    generation === undefined ? () => assertCloudConnectionOwner(location, undefined) : undefined,
  );
}

export function cloudConnectionUnavailable(
  reason: (typeof CLOUD_CONNECTION_REASONS)[keyof typeof CLOUD_CONNECTION_REASONS]['reason'],
  recordReadCode?: 'EACCES' | 'EPERM' | 'EIO' | 'ENOTDIR',
): AppError {
  return new AppError('COMMAND_FAILED', 'The cloud connection cannot serve this command.', {
    reason,
    ...(recordReadCode ? { recordReadCode } : {}),
    hint: 'Run agent-device disconnect in this session to recover it, then reconnect.',
  });
}
