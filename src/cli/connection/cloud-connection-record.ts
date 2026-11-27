import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  acquireProcessLock,
  ensurePrivateDirectorySync,
  lstatIfPresent,
  openVerifiedFileForRead,
  PrivateDirectoryInitializingError,
  PrivateDirectoryUnsafeError,
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
import { asCloudRecord } from '../cloud-response.ts';
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

type VerifiedDirectoryHandle = Readonly<{
  dirPath: string;
  dev: number | bigint;
  ino: number | bigint;
  fd: number | undefined;
}>;

const lockedCloudStateRoot = new AsyncLocalStorage<VerifiedDirectoryHandle>();

export function cloudConnectionDir({ stateDir, session }: ConnectionLocation): string {
  return path.join(stateDir, 'cloud-connections', hash(session));
}

function closeVerifiedDirectoryHandle(handle: VerifiedDirectoryHandle | undefined): void {
  if (handle?.fd === undefined) return;
  try {
    fs.closeSync(handle.fd);
  } catch {}
}

function openNoFollowDirectoryFd(dirPath: string): number {
  const flags =
    fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0) | (fs.constants.O_NOFOLLOW ?? 0);
  try {
    return fs.openSync(dirPath, flags);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ELOOP' || code === 'ENOTDIR' || code === 'ENOENT') {
      throw cloudConnectionUnavailable(CLOUD_CONNECTION_REASONS.credentialStoreUnsafe.reason);
    }
    throw error;
  }
}

function assertVerifiedDirectoryStats(
  status: fs.Stats,
  exposure: number,
  requireLiveLinks = false,
): void {
  assertOwnedEntry(status, status.isDirectory() && !status.isSymbolicLink(), exposure);
  if (process.platform !== 'win32' && (status.mode & 0o700) !== 0o700) {
    throw cloudConnectionUnavailable(CLOUD_CONNECTION_REASONS.credentialStoreUnsafe.reason);
  }
  if (requireLiveLinks && process.platform !== 'win32' && status.nlink <= 0) {
    throw cloudConnectionUnavailable(CLOUD_CONNECTION_REASONS.credentialStoreUnsafe.reason);
  }
}

function openVerifiedDirectoryHandle(
  dirPath: string,
  exposure: number,
  allowMissing = false,
): VerifiedDirectoryHandle | undefined {
  const resolved = path.resolve(dirPath);
  const seen = lstatIfPresent(resolved);
  if (!seen) {
    if (allowMissing) return undefined;
    throw cloudConnectionUnavailable(CLOUD_CONNECTION_REASONS.credentialStoreUnsafe.reason);
  }
  assertVerifiedDirectoryStats(seen, exposure);
  if (process.platform === 'win32') {
    return { dirPath: resolved, dev: seen.dev, ino: seen.ino, fd: undefined };
  }
  const fd = openNoFollowDirectoryFd(resolved);
  try {
    const fstat = fs.fstatSync(fd);
    assertVerifiedDirectoryStats(fstat, exposure, true);
    if (fstat.dev !== seen.dev || fstat.ino !== seen.ino) {
      throw cloudConnectionUnavailable(CLOUD_CONNECTION_REASONS.credentialStoreUnsafe.reason);
    }
    return { dirPath: resolved, dev: fstat.dev, ino: fstat.ino, fd };
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

function assertDirectoryHandleIntact(handle: VerifiedDirectoryHandle, exposure: number): void {
  if (process.platform === 'win32') {
    const seen = lstatIfPresent(handle.dirPath);
    if (
      !seen ||
      seen.isSymbolicLink() ||
      !seen.isDirectory() ||
      seen.dev !== handle.dev ||
      seen.ino !== handle.ino
    ) {
      throw cloudConnectionUnavailable(CLOUD_CONNECTION_REASONS.credentialStoreUnsafe.reason);
    }
    return;
  }
  const fstat = fs.fstatSync(handle.fd!);
  assertVerifiedDirectoryStats(fstat, exposure, true);
  if (fstat.dev !== handle.dev || fstat.ino !== handle.ino) {
    throw cloudConnectionUnavailable(CLOUD_CONNECTION_REASONS.credentialStoreUnsafe.reason);
  }
  const current = openNoFollowDirectoryFd(handle.dirPath);
  try {
    const currentStat = fs.fstatSync(current);
    assertVerifiedDirectoryStats(currentStat, exposure, true);
    if (currentStat.dev !== handle.dev || currentStat.ino !== handle.ino) {
      throw cloudConnectionUnavailable(CLOUD_CONNECTION_REASONS.credentialStoreUnsafe.reason);
    }
  } finally {
    fs.closeSync(current);
  }
}

function resolveInsideVerifiedHandle(
  handle: VerifiedDirectoryHandle,
  relativePath: string,
): string {
  if (process.platform === 'linux' && handle.fd !== undefined) {
    return path.posix.join(`/proc/self/fd/${handle.fd}`, relativePath);
  }
  return path.join(handle.dirPath, relativePath);
}

export async function withConnectionLock<T>(
  stateDir: string,
  session: string,
  task: () => Promise<T>,
  onContention?: () => void,
): Promise<T> {
  withCredentialStoreSafety(() => ensurePrivateDirectorySync(stateDir));
  const rootHandle = openVerifiedDirectoryHandle(stateDir, 0o022)!;
  const assertRoot = () => assertDirectoryHandleIntact(rootHandle, 0o022);
  try {
    return await withProcessLock({
      acquire: async () => {
        try {
          return await acquireProcessLock({
            ...connectionLockOptions({ stateDir, session }),
            ensureParentDir: false,
            assertParentIntact: assertRoot,
            resolveEntryPath: (logicalPath) =>
              resolveInsideVerifiedHandle(rootHandle, path.basename(logicalPath)),
            timeoutMs: 180_000,
            onContention,
          });
        } catch (error) {
          const code = (error as NodeJS.ErrnoException | null)?.code;
          if (code === 'ENOENT' || code === 'ENOTDIR') {
            throw cloudConnectionUnavailable(CLOUD_CONNECTION_REASONS.credentialStoreUnsafe.reason);
          }
          throw error;
        }
      },
      task: async () => {
        assertRoot();
        return await lockedCloudStateRoot.run(rootHandle, task);
      },
    });
  } finally {
    closeVerifiedDirectoryHandle(rootHandle);
  }
}

export async function tryWithConnectionLock(
  location: ConnectionLocation,
  task: () => Promise<void> | void,
): Promise<void> {
  withCredentialStoreSafety(() => ensurePrivateDirectorySync(location.stateDir));
  const rootHandle = openVerifiedDirectoryHandle(location.stateDir, 0o022)!;
  const assertRoot = () => assertDirectoryHandleIntact(rootHandle, 0o022);
  try {
    let lock;
    try {
      lock = tryAcquireProcessLock({
        ...connectionLockOptions(location),
        ensureParentDir: false,
        assertParentIntact: assertRoot,
        resolveEntryPath: (logicalPath) =>
          resolveInsideVerifiedHandle(rootHandle, path.basename(logicalPath)),
      });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        throw cloudConnectionUnavailable(CLOUD_CONNECTION_REASONS.credentialStoreUnsafe.reason);
      }
      throw error;
    }
    if (lock.status !== 'acquired') return;
    await withProcessLock({
      acquire: async () => lock.acquisition.release,
      task: async () => {
        assertRoot();
        return await lockedCloudStateRoot.run(rootHandle, async () => await task());
      },
    });
  } finally {
    closeVerifiedDirectoryHandle(rootHandle);
  }
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

function withCredentialStoreSafety<T>(run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof PrivateDirectoryUnsafeError) {
      throw cloudConnectionUnavailable(CLOUD_CONNECTION_REASONS.credentialStoreUnsafe.reason);
    }
    throw error;
  }
}

export function admitCloudCredentialDirectory(
  location: ConnectionLocation,
  create = false,
): boolean {
  return withAdmittedCredentialDirectoryHandle(location, create, () => true).admitted;
}

function withAdmittedCredentialDirectoryHandle<T>(
  location: ConnectionLocation,
  create: boolean,
  task: (target: { rootHandle: VerifiedDirectoryHandle; connHandle: VerifiedDirectoryHandle }) => T,
): { admitted: true; value: T } | { admitted: false } {
  return withCredentialStoreSafety(() => {
    const lockedRoot = lockedCloudStateRoot.getStore();
    let ownedRoot: VerifiedDirectoryHandle | undefined;
    let rootHandle: VerifiedDirectoryHandle | undefined;
    if (lockedRoot && lockedRoot.dirPath === path.resolve(location.stateDir)) {
      // Under an active connection lock, never recreate a vanished root or accept a substituted one.
      assertDirectoryHandleIntact(lockedRoot, 0o022);
      rootHandle = lockedRoot;
    } else {
      if (create) ensurePrivateDirectorySync(location.stateDir);
      ownedRoot = openVerifiedDirectoryHandle(location.stateDir, 0o022, !create);
      if (!ownedRoot) return { admitted: false };
      rootHandle = ownedRoot;
    }
    let cloudHandle: VerifiedDirectoryHandle | undefined;
    let connHandle: VerifiedDirectoryHandle | undefined;
    try {
      const cloudPath = resolveInsideVerifiedHandle(rootHandle, 'cloud-connections');
      cloudHandle = openOrCreateVerifiedSubdir(
        rootHandle,
        cloudPath,
        'cloud-connections',
        0o022,
        create,
      );
      if (!cloudHandle) return { admitted: false };
      const sessionSegment = hash(location.session);
      const connPath = resolveInsideVerifiedHandle(cloudHandle, sessionSegment);
      connHandle = openOrCreateVerifiedSubdir(cloudHandle, connPath, sessionSegment, 0o077, create);
      if (!connHandle) return { admitted: false };
      assertDirectoryHandleIntact(rootHandle, 0o022);
      assertDirectoryHandleIntact(cloudHandle, 0o022);
      assertDirectoryHandleIntact(connHandle, 0o077);
      const result = task({ rootHandle, connHandle });
      assertDirectoryHandleIntact(rootHandle, 0o022);
      assertDirectoryHandleIntact(connHandle, 0o077);
      return { admitted: true, value: result };
    } finally {
      closeVerifiedDirectoryHandle(connHandle);
      closeVerifiedDirectoryHandle(cloudHandle);
      closeVerifiedDirectoryHandle(ownedRoot);
    }
  });
}

const CLOUD_DIR_WAIT_BUFFER = new Int32Array(new SharedArrayBuffer(4));

function waitForCloudSubdirOwnerBits(dirPath: string, initial: fs.Stats): fs.Stats {
  let current = initial;
  for (let attempt = 0; attempt < 15; attempt += 1) {
    if ((current.mode & 0o700) === 0o700) return current;
    Atomics.wait(CLOUD_DIR_WAIT_BUFFER, 0, 0, 10);
    const next = lstatIfPresent(dirPath);
    if (!next || next.isSymbolicLink() || !next.isDirectory()) return current;
    current = next;
  }
  return current;
}

function ensureCloudSubdirOwnerBitsReady(entryPath: string, stats: fs.Stats | undefined): void {
  if (
    process.platform === 'win32' ||
    !stats ||
    stats.isSymbolicLink() ||
    !stats.isDirectory() ||
    (stats.mode & 0o700) === 0o700
  ) {
    return;
  }
  const ready = waitForCloudSubdirOwnerBits(entryPath, stats);
  if ((ready.mode & 0o700) !== 0o700) {
    throw new PrivateDirectoryInitializingError(
      'COMMAND_FAILED',
      `Private directory ${entryPath} does not grant owner read/write/execute permissions yet.`,
      { retriable: true, path: entryPath },
    );
  }
}

function createPrivateSubdirInsideHandle(
  parentHandle: VerifiedDirectoryHandle,
  entryPath: string,
  childName: string,
  exposure: number,
): VerifiedDirectoryHandle {
  assertDirectoryHandleIntact(parentHandle, 0o022);
  let created = true;
  try {
    fs.mkdirSync(entryPath, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    created = false;
  }
  if (!created) {
    ensureCloudSubdirOwnerBitsReady(entryPath, lstatIfPresent(entryPath));
    return openVerifiedDirectoryHandle(entryPath, exposure, false)!;
  }
  const seen = lstatIfPresent(entryPath);
  if (!seen || seen.isSymbolicLink() || !seen.isDirectory()) {
    throw cloudConnectionUnavailable(CLOUD_CONNECTION_REASONS.credentialStoreUnsafe.reason);
  }
  if (process.platform === 'win32') {
    return {
      dirPath: path.join(parentHandle.dirPath, childName),
      dev: seen.dev,
      ino: seen.ino,
      fd: undefined,
    };
  }
  if ((seen.mode & 0o077) !== 0) {
    throw cloudConnectionUnavailable(CLOUD_CONNECTION_REASONS.credentialStoreUnsafe.reason);
  }
  const mode = seen.mode & 0o777;
  if (mode !== 0o700) {
    if ((mode & 0o400) !== 0) {
      const fd = openNoFollowDirectoryFd(entryPath);
      try {
        const fstat = fs.fstatSync(fd);
        if (!fstat.isDirectory() || fstat.dev !== seen.dev || fstat.ino !== seen.ino) {
          throw cloudConnectionUnavailable(CLOUD_CONNECTION_REASONS.credentialStoreUnsafe.reason);
        }
        fs.fchmodSync(fd, 0o700);
        const updated = fs.fstatSync(fd);
        assertVerifiedDirectoryStats(updated, exposure, true);
        return {
          dirPath: path.join(parentHandle.dirPath, childName),
          dev: updated.dev,
          ino: updated.ino,
          fd,
        };
      } catch (error) {
        fs.closeSync(fd);
        throw error;
      }
    }
    assertDirectoryHandleIntact(parentHandle, 0o022);
    const latest = lstatIfPresent(entryPath);
    if (
      !latest ||
      latest.isSymbolicLink() ||
      !latest.isDirectory() ||
      latest.dev !== seen.dev ||
      latest.ino !== seen.ino
    ) {
      throw cloudConnectionUnavailable(CLOUD_CONNECTION_REASONS.credentialStoreUnsafe.reason);
    }
    fs.chmodSync(entryPath, 0o700);
  }
  const fd = openNoFollowDirectoryFd(entryPath);
  try {
    const fstat = fs.fstatSync(fd);
    assertVerifiedDirectoryStats(fstat, exposure, true);
    if (fstat.dev !== seen.dev || fstat.ino !== seen.ino) {
      throw cloudConnectionUnavailable(CLOUD_CONNECTION_REASONS.credentialStoreUnsafe.reason);
    }
    return {
      dirPath: path.join(parentHandle.dirPath, childName),
      dev: fstat.dev,
      ino: fstat.ino,
      fd,
    };
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

function openOrCreateVerifiedSubdir(
  parentHandle: VerifiedDirectoryHandle,
  entryPath: string,
  childName: string,
  exposure: number,
  create: boolean,
): VerifiedDirectoryHandle | undefined {
  const existing = lstatIfPresent(entryPath);
  if (!existing) {
    if (!create) return undefined;
    return createPrivateSubdirInsideHandle(parentHandle, entryPath, childName, exposure);
  }
  ensureCloudSubdirOwnerBitsReady(entryPath, existing);
  return openVerifiedDirectoryHandle(entryPath, exposure, !create);
}

export function withCloudCredentialFileTarget<T>(
  location: ConnectionLocation,
  fileName: 'record.json' | 'attachment.json',
  create: boolean,
  writeOrRead: (filePath: string) => T,
): T {
  const ran = withAdmittedCredentialDirectoryHandle(location, create, ({ connHandle }) =>
    writeOrRead(resolveInsideVerifiedHandle(connHandle, fileName)),
  );
  if (!ran.admitted) {
    throw cloudConnectionUnavailable(CLOUD_CONNECTION_REASONS.credentialStoreUnsafe.reason);
  }
  return ran.value;
}

function admitCloudStateRoot(stateDir: string): boolean {
  const handle = openVerifiedDirectoryHandle(stateDir, 0o022, true);
  if (!handle) return false;
  closeVerifiedDirectoryHandle(handle);
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
  withCloudCredentialFileTarget(location, 'record.json', true, (targetPath) => {
    publishFileSync({
      destination: targetPath,
      contents: JSON.stringify(record),
      mode: 0o600,
    });
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
      let current: CloudConnectionRecord | null;
      let kind: unknown;
      try {
        current = readCloudConnection(location);
        if (!current || !isExpired(current)) return;
        kind = readExpiredAttachmentKind(location);
      } catch {
        return;
      }
      if (current.phase === 'pending' || kind === 'agent-device-daemon') {
        removeCloudAttachment(location);
      } else {
        await retireExpiredDaemon(location, current.generation).then(
          () => removeCloudAttachment(location),
          () => undefined,
        );
      }
    });
  }
}

function readExpiredAttachmentKind(location: ConnectionLocation): unknown {
  try {
    return asCloudRecord(readCloudCredentialJson(cloudAttachmentPath(location)))?.kind;
  } catch {
    return undefined;
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
  if (!status?.isDirectory() || !isOwnedEntry(status, 0o077)) return undefined;
  let record: CloudConnectionRecord | null;
  try {
    record = readRecordFile(path.join(dir, 'record.json'));
  } catch {
    return undefined;
  }
  if (
    typeof record?.session !== 'string' ||
    !isExpired(record) ||
    (!record.hostedLeaseId && !lstatIfPresent(path.join(dir, 'attachment.json')))
  )
    return undefined;
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
