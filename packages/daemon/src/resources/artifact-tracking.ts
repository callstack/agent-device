import { runtimeSlot } from '@agent-device/host-kit/runtime-slots';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { finished } from 'node:stream/promises';
import {
  AppError,
  createRequestCanceledError,
  type ReasonTable,
} from '@agent-device/kernel/errors';
import type { DaemonArtifact, DaemonArtifactType } from '@agent-device/kernel/contracts';
import type { DeviceRotation } from '@agent-device/contracts/device';
import { normalizeLeaseId } from '@agent-device/contracts/lease-scope';
import type { DaemonArtifactInventoryEntry } from '@agent-device/contracts/observability';
import type { PackedGzipTar } from '@agent-device/host-kit/gzip-tar';
import {
  expiredTenantOwnedEntryError,
  requireTenantOwnedEntry,
  type TenantOwnedResourceKind,
} from '../core/tenant-owned-entry.ts';
import {
  getDiagnosticsMeta,
  registerDiagnosticSensitiveValue,
  updateDiagnosticsScope,
} from '@agent-device/host-kit/diagnostics';
import { timingSafeStringEqual } from '@agent-device/host-kit/transport';
import type { DaemonRequest } from '../core/daemon-request.ts';
import type { SessionRef } from '../core/session-state.ts';
import type { SessionStore } from '../core/session-store.ts';
import { resolveLeaseScope } from '../core/lease-context.ts';

// --- Leased output ownership ---

/** The `error.details.reason` values a leased-output refusal publishes. */
const LEASED_OUTPUT_REASONS = {
  // The request does not send the id of the lease that produced the artifact or diagnostics record.
  leaseMismatch: { reason: 'LEASE_OUTPUT_MISMATCH' },
} as const satisfies ReasonTable<'leases'>;

/** What a record keeps to check a reader against its lease: the SHA-256 of the lease id, never the id. */
export function leaseVerifier(leaseId: string): string {
  const canonical = normalizeLeaseId(leaseId) ?? leaseId.trim();
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

export function admittedOutputLeaseVerifier(req: Pick<DaemonRequest, 'internal'>): string | null {
  const leaseId = req.internal?.admittedLease?.leaseId;
  return leaseId === undefined ? null : leaseVerifier(leaseId);
}

export function requestTraceDiagnostics(
  req: DaemonRequest,
  ref: SessionRef | undefined,
  store: Pick<SessionStore, 'resolveCurrent'>,
) {
  const trace = ref?.session.trace;
  const owner = trace?.leaseVerifier ?? null;
  if (!ref || !trace || owner !== admittedOutputLeaseVerifier(req)) {
    return {
      traceLogPath: undefined,
      traceLogWritable: undefined,
      runnerTraceLogWritable: undefined,
    };
  }
  const unleasedCallerTrace = trace.outPath !== undefined && owner === null && !ref.session.lease;
  const traceLogWritable = () => store.resolveCurrent(ref)?.trace === trace;
  return {
    traceLogPath: trace.remoteCaptureOutputPath ?? trace.outPath,
    traceLogWritable,
    runnerTraceLogWritable: unleasedCallerTrace ? traceLogWritable : undefined,
  };
}

/**
 * Whether a request may read output that a lease produced. Output of a leased request belongs to
 * that lease for as long as the output is kept, also after the lease ends: only a request that
 * sends the lease id reads it (ADR 0007). Output with no lease has no lease rule.
 */
export function requestHoldsOutputLease(
  ownerVerifier: string | undefined,
  presentedLeaseId: string | undefined,
): boolean {
  if (ownerVerifier === undefined) return true;
  return (
    presentedLeaseId !== undefined &&
    timingSafeStringEqual(leaseVerifier(presentedLeaseId), ownerVerifier)
  );
}

export function leasedOutputRefusal(label: string): AppError {
  return new AppError('UNAUTHORIZED', `${label} belongs to a device lease. Send its lease id.`, {
    reason: LEASED_OUTPUT_REASONS.leaseMismatch.reason,
    field: 'leaseId',
  });
}

const UNLEASED_RECORD = 'unleased';
const DIAGNOSTICS_RECORD_ID = new RegExp(`^[a-f0-9]{32}-(${UNLEASED_RECORD}|[a-f0-9]{64})$`);

/**
 * Names the diagnostics record of a request that no other request opened: a server-chosen id that
 * carries its owner, the lease id that the request sent, or that it sent none. The caller's request
 * id names no record, so two requests never share one, and a record has one owner or none.
 */
export function claimRequestDiagnosticsRecord(req: Pick<DaemonRequest, 'flags' | 'meta'>): void {
  const claim = resolveLeaseScope(req).leaseId;
  const leaseId = typeof claim === 'string' ? claim : undefined;
  // A lease id that reaches a message, and not a lease field, is removed from the record too.
  if (leaseId !== undefined) {
    // A malformed id is no credential, but the record still never echoes what the caller sent.
    registerDiagnosticSensitiveValue(leaseId.trim());
    const canonical = normalizeLeaseId(leaseId);
    if (canonical) registerDiagnosticSensitiveValue(canonical);
  }
  const verifier = leaseId === undefined ? undefined : leaseVerifier(leaseId);
  const inheritedRecordId = getDiagnosticsMeta().recordId;
  if (inheritedRecordId && diagnosticsRecordOwner(inheritedRecordId) === verifier) return;
  const owner = verifier ?? UNLEASED_RECORD;
  updateDiagnosticsScope({ recordId: `${crypto.randomBytes(16).toString('hex')}-${owner}` });
}

/** The name of the diagnostics record that the running request writes. */
export function requestDiagnosticsRecordId(req: Pick<DaemonRequest, 'meta'>): string | undefined {
  const scope = getDiagnosticsMeta();
  return scope.recordId ?? req.meta?.requestId ?? scope.requestId;
}

/**
 * The lease that owns the diagnostics record `recordId` names: `undefined` for a record of a
 * request that sent no lease id. Returns `null` for a name that this daemon did not choose, such as
 * a record from a release that named records by the caller's request id. Its owner is not known.
 */
export function diagnosticsRecordOwner(recordId: string): string | undefined | null {
  const owner = DIAGNOSTICS_RECORD_ID.exec(recordId)?.[1];
  if (owner === undefined) return null;
  return owner === UNLEASED_RECORD ? undefined : owner;
}

// --- Downloadable artifact tracking ---

const ARTIFACT_CLEANUP_TIMEOUT_MS = 15 * 60 * 1000;
const ARTIFACT_DOWNLOAD_MAX_LIFETIME_MS = 15 * 60 * 1000;

const DOWNLOADABLE_ARTIFACT_RESOURCE: TenantOwnedResourceKind = {
  label: 'Artifact',
  expiredHint: `Downloadable artifacts are removed after download or after ${ARTIFACT_CLEANUP_TIMEOUT_MS / 60_000} minutes. Re-run the command that produced the artifact and download it again.`,
};
const DEFAULT_DOWNLOAD_MIME_TYPE = 'application/octet-stream';
const DIRECTORY_ARCHIVE_MIME_TYPE = 'application/gzip';

type DirectoryArchive = {
  archivePath: string;
  cleanup(): void;
  fileName: string;
  sizeBytes: number;
};

type DirectoryArchiveBuild = {
  promise: Promise<DirectoryArchive>;
  controller: AbortController;
  waiters: number;
};

type ArtifactSourceCleanup = {
  remainingEntries: number;
  deleteAfterDownload: boolean;
};

type ArtifactDownload = {
  controller: AbortController;
  stream?: fs.ReadStream;
  release: () => void;
};

type ArtifactEntry = {
  artifactPath: string;
  tenantId?: string;
  leaseVerifier?: string;
  reservation?: Readonly<{ directory: string; lifetimeId: string }>;
  /** The output that was registered. Another output written to `artifactPath` is not this artifact. */
  output: string | undefined;
  artifactType: DaemonArtifactType | undefined;
  fileName?: string;
  displayRotation?: DeviceRotation;
  sessionName?: string;
  sourceCleanup: ArtifactSourceCleanup;
  createdAt: number;
  directoryArchive?: DirectoryArchive;
  directoryArchiveBuild?: DirectoryArchiveBuild;
  activeDownloads: Set<ArtifactDownload>;
  cleanupRequested: boolean;
  timer: ReturnType<typeof setTimeout>;
};

type ArtifactTrackingState = {
  artifacts: Map<string, ArtifactEntry>;
  reservations: Set<() => void>;
  uploads: Map<string, UploadEntry>;
  retainedPerformanceSources: Map<
    string,
    { output: string; leaseVerifier: string | null; birthtimeMs: number }
  >;
};

const ARTIFACT_TRACKING_SLOT = Symbol('artifactTracking');
const artifactTracking = (): ArtifactTrackingState =>
  runtimeSlot(
    ARTIFACT_TRACKING_SLOT,
    (): ArtifactTrackingState => ({
      artifacts: new Map(),
      reservations: new Set(),
      uploads: new Map(),
      retainedPerformanceSources: new Map(),
    }),
    (state) => {
      for (const discard of state.reservations) discard();
      for (const [id, entry] of state.artifacts) {
        requestArtifactCleanup(state.artifacts, id, entry);
        for (const download of entry.activeDownloads) cancelArtifactDownload(id, entry, download);
      }
      for (const entry of state.uploads.values()) {
        clearTimeout(entry.timer);
        removeBestEffort(entry.tempDir);
      }
    },
  );
const pendingArtifacts = () => artifactTracking().artifacts;
const pendingUploads = () => artifactTracking().uploads;
const committedFileOutputRevocations = new WeakMap<DaemonArtifact, () => void>();

/** Revoke only producer-committed outputs on the discarded success response. */
export function revokeUndeliveredFileOutputs(
  artifacts: readonly DaemonArtifact[] | undefined,
): void {
  for (const artifact of artifacts ?? []) {
    const revoke = committedFileOutputRevocations.get(artifact);
    committedFileOutputRevocations.delete(artifact);
    revoke?.();
  }
}

/** What a finished request registers for each artifact it hands back to the client. */
export type DownloadableArtifactRegistration = {
  artifactPath: string;
  tenantId?: string;
  /** {@link leaseVerifier} of the lease that produced the artifact. Only a request that sends that lease id lists or downloads it. */
  leaseVerifier?: string;
  artifactType: DaemonArtifactType | undefined;
  fileName?: string;
  displayRotation?: DeviceRotation;
  /** Public session name, for an artifact registered outside a request reply. */
  sessionName?: string;
  deleteAfterDownload?: boolean;
};

export type TrackDownloadableArtifact = (registration: DownloadableArtifactRegistration) => string;

type FileOutputProducer = Readonly<{
  lifetimeId: string;
  tenantId: string | undefined;
  leaseVerifier: string | null;
}>;

type FileOutputDelivery = Pick<DaemonArtifact, 'field' | 'fileName' | 'localPath'> & {
  displayRotation?: DeviceRotation;
};

/** Reserves private storage and pins the admitted producer before invoking the writer. */
export function reserveFileOutput(
  artifactType: DaemonArtifactType,
  filename: string,
  producer: FileOutputProducer,
) {
  const { artifacts, reservations } = artifactTracking();
  const id = crypto.randomUUID();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-output-'));
  const artifactPath = path.join(directory, path.basename(filename));
  const { lifetimeId, tenantId, leaseVerifier } = producer;
  const discard = () => {
    if (reservations.delete(discard)) removeBestEffort(directory);
  };
  reservations.add(discard);
  return {
    path: artifactPath,
    discard,
    commit({ displayRotation, ...delivery }: FileOutputDelivery): DaemonArtifact & {
      artifactId: string;
    } {
      const stat = reservations.has(discard)
        ? fs.lstatSync(artifactPath, { throwIfNoEntry: false })
        : undefined;
      if (!stat?.isFile()) {
        throw new AppError('COMMAND_FAILED', 'Reserved output did not produce a regular file.');
      }
      addArtifactEntry(
        artifacts,
        id,
        {
          artifactPath,
          artifactType,
          tenantId,
          leaseVerifier: leaseVerifier ?? undefined,
          fileName: delivery.fileName,
          displayRotation,
        },
        outputIdentity(stat),
        { remainingEntries: 1, deleteAfterDownload: true },
        { directory, lifetimeId },
      );
      reservations.delete(discard);
      const artifact = { ...delivery, artifactType, artifactId: id };
      committedFileOutputRevocations.set(artifact, () => {
        const entry = artifacts.get(id);
        if (!entry) return;
        requestArtifactCleanup(artifacts, id, entry);
        for (const download of entry.activeDownloads) cancelArtifactDownload(id, entry, download);
      });
      return artifact;
    },
  };
}

/** What a request presents to list or download artifacts. */
export type DownloadableArtifactReader = { tenantId?: string; leaseId?: string };

type PreparedDownloadableArtifact = {
  artifactPath: string;
  fileName?: string;
  mimeType: string;
  sizeBytes: number;
};

export type OpenedDownloadableArtifact = PreparedDownloadableArtifact & {
  stream: fs.ReadStream;
  signal: AbortSignal;
  /** Release ownership after the download pipeline settles, including failure. */
  release: () => void;
};

/**
 * Registers one output for download and returns its id. The same output registered again for the
 * same tenant and lease returns its existing entry unchanged: two ids for one file would each
 * delete it after their own download. An id serves only the output that it registered: another
 * output written to the same path gets its own id, and the earlier id expires.
 */
export function trackDownloadableArtifact(params: DownloadableArtifactRegistration): string {
  const output = readOutputIdentity(params.artifactPath);
  const existingId = findTrackedArtifactId(params, output);
  if (existingId) return existingId;
  const artifactId = crypto.randomUUID();
  const sourceCleanup = findArtifactSourceCleanup(params.artifactPath, output) ?? {
    remainingEntries: 0,
    deleteAfterDownload: true,
  };
  sourceCleanup.remainingEntries += 1;
  sourceCleanup.deleteAfterDownload &&= params.deleteAfterDownload !== false;
  addArtifactEntry(pendingArtifacts(), artifactId, params, output, sourceCleanup);
  return artifactId;
}

function addArtifactEntry(
  artifacts: Map<string, ArtifactEntry>,
  artifactId: string,
  params: DownloadableArtifactRegistration,
  output: string | undefined,
  sourceCleanup: ArtifactSourceCleanup,
  reservation?: ArtifactEntry['reservation'],
): void {
  const createdAt = Date.now();
  const timer = setTimeout(() => {
    const entry = artifacts.get(artifactId);
    if (entry) requestArtifactCleanup(artifacts, artifactId, entry);
  }, ARTIFACT_CLEANUP_TIMEOUT_MS);
  timer.unref();
  artifacts.set(artifactId, {
    artifactPath: params.artifactPath,
    tenantId: params.tenantId,
    ...(params.leaseVerifier !== undefined ? { leaseVerifier: params.leaseVerifier } : {}),
    output,
    reservation,
    artifactType: params.artifactType,
    fileName: params.fileName,
    ...(params.displayRotation !== undefined ? { displayRotation: params.displayRotation } : {}),
    ...(params.sessionName !== undefined ? { sessionName: params.sessionName } : {}),
    sourceCleanup,
    activeDownloads: new Set(),
    cleanupRequested: false,
    createdAt,
    timer,
  });
}

function findTrackedArtifactId(
  owner: Pick<DownloadableArtifactRegistration, 'artifactPath' | 'tenantId' | 'leaseVerifier'>,
  output: string | undefined,
): string | undefined {
  for (const [artifactId, entry] of pendingArtifacts()) {
    if (
      !entry.cleanupRequested &&
      !entry.reservation &&
      entry.artifactPath === owner.artifactPath &&
      entry.output === output &&
      entry.tenantId === owner.tenantId &&
      entry.leaseVerifier === owner.leaseVerifier
    )
      return artifactId;
  }
  return undefined;
}

function findArtifactSourceCleanup(
  artifactPath: string,
  output: string | undefined,
): ArtifactSourceCleanup | undefined {
  for (const entry of pendingArtifacts().values()) {
    if (!entry.reservation && entry.artifactPath === artifactPath && entry.output === output) {
      return entry.sourceCleanup;
    }
  }
  return undefined;
}

/** What tells one output at a path from the next one written there. A directory keeps its identity while its entries change. */
function outputIdentity(stat: fs.Stats): string {
  const inode = `${stat.dev}:${stat.ino}`;
  return stat.isDirectory() ? inode : `${inode}:${stat.size}:${stat.mtimeMs}`;
}

function readOutputIdentity(artifactPath: string, noFollow = false): string | undefined {
  try {
    return outputIdentity(noFollow ? fs.lstatSync(artifactPath) : fs.statSync(artifactPath));
  } catch {
    return undefined;
  }
}

/** Keeps the report source owner independently of the downloadable copy and latest handoff. */
export function retainPerfReportSource(source: string, leaseVerifier: string | null): void {
  const canonical = fs.realpathSync(source);
  const stat = fs.statSync(canonical);
  artifactTracking().retainedPerformanceSources.set(canonical, {
    output: outputIdentity(stat),
    birthtimeMs: stat.birthtimeMs,
    leaseVerifier,
  });
}

/** Checks both resolved paths and source identities, including renamed or aliased sources. */
export function assertTrackedPerformanceSourceLease(
  canonical: string,
  source: fs.Stats,
  caller: string | null,
): void {
  const identity = outputIdentity(source);
  const state = artifactTracking();
  for (const [retainedPath, entry] of state.retainedPerformanceSources) {
    if (
      entry.leaseVerifier &&
      entry.leaseVerifier !== caller &&
      (canonical === retainedPath ||
        (identity === entry.output && source.birthtimeMs === entry.birthtimeMs))
    ) {
      throw leasedOutputRefusal('Performance capture');
    }
  }
  for (const entry of state.artifacts.values()) {
    if (
      entry.artifactType === 'performance' &&
      entry.leaseVerifier &&
      entry.leaseVerifier !== caller &&
      entry.output === identity
    ) {
      throw leasedOutputRefusal('Performance capture');
    }
  }
}

export async function openDownloadableArtifact(
  artifactId: string,
  reader: DownloadableArtifactReader,
  hostEnv: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<OpenedDownloadableArtifact> {
  if (signal?.aborted) throw createRequestCanceledError();
  const artifacts = pendingArtifacts();
  const { entry, stat } = readDownloadableArtifactEntry(artifactId, reader);
  const download: ArtifactDownload = {
    controller: new AbortController(),
    release: () => {
      if (!entry.activeDownloads.delete(download)) return;
      clearTimeout(deadline);
      signal?.removeEventListener('abort', cancel);
      if (entry.cleanupRequested) requestArtifactCleanup(artifacts, artifactId, entry);
    },
  };
  entry.activeDownloads.add(download);
  const deadline = setTimeout(
    () => cancelArtifactDownload(artifactId, entry, download),
    ARTIFACT_DOWNLOAD_MAX_LIFETIME_MS,
  );
  deadline.unref();
  const cancel = () =>
    cancelArtifactDownload(artifactId, entry, download, createRequestCanceledError());
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    download.controller.signal.throwIfAborted();
    const payload = await prepareArtifactPayload(
      artifactId,
      entry,
      stat,
      hostEnv,
      download.controller.signal,
    );
    download.controller.signal.throwIfAborted();
    if (!payload) {
      throw new AppError(
        'COMMAND_FAILED',
        `Artifact path is not a regular file or directory: ${entry.artifactPath}`,
      );
    }
    const stream = stat.isFile()
      ? openRegisteredFile(artifactId, entry)
      : fs.createReadStream(payload.artifactPath);
    download.stream = stream;
    return { ...payload, stream, signal: download.controller.signal, release: download.release };
  } catch (error) {
    download.release();
    throw error;
  }
}

function openRegisteredFile(artifactId: string, entry: ArtifactEntry): fs.ReadStream {
  const fd = fs.openSync(
    entry.artifactPath,
    fs.constants.O_RDONLY |
      fs.constants.O_NONBLOCK |
      (entry.reservation ? fs.constants.O_NOFOLLOW : 0),
  );
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || outputIdentity(stat) !== entry.output) {
      cleanupDownloadableArtifact(artifactId);
      throw expiredTenantOwnedEntryError(DOWNLOADABLE_ARTIFACT_RESOURCE, artifactId);
    }
    return fs.createReadStream(entry.artifactPath, { fd });
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

function cancelArtifactDownload(
  artifactId: string,
  entry: ArtifactEntry,
  download: ArtifactDownload,
  reason: unknown = expiredTenantOwnedEntryError(DOWNLOADABLE_ARTIFACT_RESOURCE, artifactId),
): void {
  if (!entry.activeDownloads.has(download)) return;
  download.controller.abort(reason);
  if (!download.stream) return;
  const closed = finished(download.stream, { cleanup: true }).catch(() => {});
  download.stream.destroy();
  void closed.then(download.release);
}

export async function listDownloadableArtifacts(
  reader: DownloadableArtifactReader,
  hostEnv: NodeJS.ProcessEnv,
): Promise<DaemonArtifactInventoryEntry[]> {
  const artifacts: DaemonArtifactInventoryEntry[] = [];
  for (const [id, entry] of pendingArtifacts()) {
    if (!canReadArtifact(entry, reader)) continue;
    const stat = statRegisteredOutput(id, entry);
    if (!stat) continue;
    const payload = await prepareArtifactPayloadForInventory(id, entry, stat, hostEnv);
    if (!payload || entry.cleanupRequested) continue;
    artifacts.push({
      id,
      ...(entry.artifactType !== undefined ? { artifactType: entry.artifactType } : {}),
      filename: payload.fileName ?? id,
      mimeType: payload.mimeType,
      sizeBytes: payload.sizeBytes,
      createdAt: new Date(entry.createdAt).toISOString(),
      expiresAt: new Date(entry.createdAt + ARTIFACT_CLEANUP_TIMEOUT_MS).toISOString(),
      ...(entry.displayRotation !== undefined ? { displayRotation: entry.displayRotation } : {}),
      ...(entry.sessionName !== undefined ? { sessionName: entry.sessionName } : {}),
    });
  }
  return artifacts;
}

/** The output that `entry` registered. Cleans the entry up when the output is gone or replaced. */
function statRegisteredOutput(artifactId: string, entry: ArtifactEntry): fs.Stats | undefined {
  try {
    const stat = statArtifactPath(entry);
    if (outputIdentity(stat) === entry.output) return stat;
  } catch {
    // A missing output is cleaned up like a replaced one.
  }
  cleanupDownloadableArtifact(artifactId);
  return undefined;
}

async function prepareArtifactPayloadForInventory(
  artifactId: string,
  entry: ArtifactEntry,
  stat: fs.Stats,
  hostEnv: NodeJS.ProcessEnv,
): Promise<PreparedDownloadableArtifact | null> {
  try {
    return await prepareArtifactPayload(artifactId, entry, stat, hostEnv);
  } catch {
    // Inventory is best-effort; direct downloads still surface artifact-specific errors.
    return null;
  }
}

function readDownloadableArtifactEntry(
  artifactId: string,
  reader: DownloadableArtifactReader,
): { entry: ArtifactEntry; stat: fs.Stats } {
  const entry = requireTenantOwnedEntry(
    pendingArtifacts(),
    artifactId,
    reader.tenantId,
    DOWNLOADABLE_ARTIFACT_RESOURCE,
  );
  if (!requestHoldsOutputLease(entry.leaseVerifier, reader.leaseId)) {
    throw leasedOutputRefusal(DOWNLOADABLE_ARTIFACT_RESOURCE.label);
  }
  if (entry.cleanupRequested) {
    throw expiredTenantOwnedEntryError(DOWNLOADABLE_ARTIFACT_RESOURCE, artifactId);
  }
  let stat: fs.Stats;
  try {
    stat = statArtifactPath(entry);
  } catch {
    cleanupDownloadableArtifact(artifactId);
    throw new AppError('COMMAND_FAILED', `Artifact file is missing: ${entry.artifactPath}`);
  }
  if (outputIdentity(stat) !== entry.output) {
    cleanupDownloadableArtifact(artifactId);
    throw expiredTenantOwnedEntryError(DOWNLOADABLE_ARTIFACT_RESOURCE, artifactId);
  }
  return { entry, stat };
}

function statArtifactPath(entry: ArtifactEntry): fs.Stats {
  return entry.reservation ? fs.lstatSync(entry.artifactPath) : fs.statSync(entry.artifactPath);
}

async function prepareArtifactPayload(
  artifactId: string,
  entry: ArtifactEntry,
  stat: fs.Stats,
  hostEnv: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<PreparedDownloadableArtifact | null> {
  if (stat.isFile()) {
    return {
      artifactPath: entry.artifactPath,
      fileName: safeArtifactFilename(entry.fileName, artifactId),
      mimeType: DEFAULT_DOWNLOAD_MIME_TYPE,
      sizeBytes: stat.size,
    };
  }
  if (!stat.isDirectory()) return null;

  const directoryArchive = await ensureDirectoryArchive(artifactId, entry, hostEnv, signal);
  return {
    artifactPath: directoryArchive.archivePath,
    fileName: directoryArchive.fileName,
    mimeType: DIRECTORY_ARCHIVE_MIME_TYPE,
    sizeBytes: directoryArchive.sizeBytes,
  };
}

async function ensureDirectoryArchive(
  artifactId: string,
  entry: ArtifactEntry,
  hostEnv: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<DirectoryArchive> {
  signal?.throwIfAborted();
  if (entry.directoryArchive && fs.existsSync(entry.directoryArchive.archivePath)) {
    return entry.directoryArchive;
  }
  const artifacts = pendingArtifacts();
  let build = entry.directoryArchiveBuild;
  if (!build || build.controller.signal.aborted) {
    const controller = new AbortController();
    build = {
      promise: createDirectoryArchive(artifactId, entry, hostEnv, controller),
      controller,
      waiters: 0,
    };
    entry.directoryArchiveBuild = build;
  }
  build.waiters += 1;
  let onAbort: (() => void) | undefined;
  const aborted =
    signal &&
    new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
  try {
    return await (aborted ? Promise.race([build.promise, aborted]) : build.promise);
  } finally {
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    build.waiters -= 1;
    if (build.waiters === 0) {
      if (signal?.aborted) {
        build.controller.abort(signal.reason);
        await build.promise.catch(() => {});
      }
      if (entry.directoryArchiveBuild === build) entry.directoryArchiveBuild = undefined;
      if (entry.cleanupRequested) requestArtifactCleanup(artifacts, artifactId, entry);
    }
  }
}

async function createDirectoryArchive(
  artifactId: string,
  entry: ArtifactEntry,
  hostEnv: NodeJS.ProcessEnv,
  controller: AbortController,
): Promise<DirectoryArchive> {
  let packed: PackedGzipTar | undefined;
  try {
    cleanupDirectoryArchive(entry);

    const sourceName = safeArtifactFilename(
      entry.fileName,
      path.basename(entry.artifactPath) || artifactId,
    );
    const fileName = archiveFilename(sourceName);
    // Loaded on demand: only a directory artifact packs, and the daemon's eager closure stays small.
    const { packGzipTar } = await import('@agent-device/host-kit/gzip-tar');
    packed = await packGzipTar(entry.artifactPath, {
      env: hostEnv,
      signal: controller.signal,
      timeoutMs: ARTIFACT_DOWNLOAD_MAX_LIFETIME_MS,
      fileName,
    });
    const archive = {
      archivePath: packed.archivePath,
      cleanup: packed.cleanup,
      fileName,
      sizeBytes: fs.statSync(packed.archivePath).size,
    };
    entry.directoryArchive = archive;
    return archive;
  } catch (error) {
    const failure = controller.signal.aborted
      ? controller.signal.reason
      : error instanceof AppError
        ? error
        : new AppError(
            'COMMAND_FAILED',
            `Failed to archive downloadable artifact: ${entry.artifactPath}`,
            { artifactPath: entry.artifactPath },
            error instanceof Error ? error : undefined,
          );
    packed?.cleanup();
    throw failure;
  }
}

function archiveFilename(fileName: string): string {
  const lowered = fileName.toLowerCase();
  if (lowered.endsWith('.tar.gz') || lowered.endsWith('.tgz')) return fileName;
  return `${fileName}.tar.gz`;
}

function canReadArtifact(entry: ArtifactEntry, reader: DownloadableArtifactReader): boolean {
  return (
    !entry.cleanupRequested &&
    (!entry.tenantId || entry.tenantId === reader.tenantId) &&
    requestHoldsOutputLease(entry.leaseVerifier, reader.leaseId)
  );
}

function safeArtifactFilename(fileName: string | undefined, fallback: string): string {
  const cleaned = fileName?.trim();
  return cleaned && !hasUnsafeFilenameCharacter(cleaned) ? cleaned : fallback;
}

function hasUnsafeFilenameCharacter(fileName: string): boolean {
  return (
    fileName.includes('/') ||
    fileName.includes('\\') ||
    fileName.includes('\0') ||
    fileName.includes('\r') ||
    fileName.includes('\n')
  );
}

export function cleanupDownloadableArtifact(artifactId: string): void {
  const artifacts = pendingArtifacts();
  const entry = artifacts.get(artifactId);
  if (!entry) return;
  requestArtifactCleanup(artifacts, artifactId, entry);
}

function requestArtifactCleanup(
  artifacts: Map<string, ArtifactEntry>,
  artifactId: string,
  entry: ArtifactEntry,
): void {
  entry.cleanupRequested = true;
  clearTimeout(entry.timer);
  if (entry.activeDownloads.size > 0 || artifacts.get(artifactId) !== entry) return;
  if (entry.directoryArchiveBuild) {
    entry.directoryArchiveBuild.controller.abort(
      expiredTenantOwnedEntryError(DOWNLOADABLE_ARTIFACT_RESOURCE, artifactId),
    );
    return;
  }
  artifacts.delete(artifactId);
  cleanupDirectoryArchive(entry);
  entry.sourceCleanup.remainingEntries -= 1;
  if (
    entry.sourceCleanup.remainingEntries === 0 &&
    entry.sourceCleanup.deleteAfterDownload &&
    entry.output !== undefined &&
    readOutputIdentity(entry.artifactPath, entry.reservation !== undefined) === entry.output
  ) {
    removeBestEffort(entry.artifactPath);
  }
  if (entry.reservation) {
    try {
      fs.rmdirSync(entry.reservation.directory);
    } catch {
      // Leave a replaced output alone.
    }
  }
}

function removeBestEffort(targetPath: string): void {
  try {
    fs.rmSync(targetPath, { recursive: true, force: true });
  } catch {
    // best-effort cleanup only
  }
}

function cleanupDirectoryArchive(entry: ArtifactEntry): void {
  if (!entry.directoryArchive) return;
  entry.directoryArchive.cleanup();
  entry.directoryArchive = undefined;
}

// --- Upload artifact tracking ---

const UPLOAD_CLEANUP_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

const UPLOADED_ARTIFACT_RESOURCE: TenantOwnedResourceKind = {
  label: 'Uploaded artifact',
  expiredHint: `Uploaded artifacts expire ${UPLOAD_CLEANUP_TIMEOUT_MS / 60_000} minutes after upload. Upload the file again and retry with the new upload id.`,
};

type UploadEntry = {
  artifactPath: string;
  tempDir: string;
  tenantId?: string;
  timer: ReturnType<typeof setTimeout>;
};

export function trackUploadedArtifact(params: {
  artifactPath: string;
  tempDir: string;
  tenantId?: string;
}): string {
  const uploadId = crypto.randomUUID();
  const timer = setTimeout(() => {
    cleanupUploadedArtifact(uploadId);
  }, UPLOAD_CLEANUP_TIMEOUT_MS);
  timer.unref();
  pendingUploads().set(uploadId, {
    artifactPath: params.artifactPath,
    tempDir: params.tempDir,
    tenantId: params.tenantId,
    timer,
  });
  return uploadId;
}

export function prepareUploadedArtifact(uploadId: string, tenantId?: string): string {
  const entry = requireTenantOwnedEntry(
    pendingUploads(),
    uploadId,
    tenantId,
    UPLOADED_ARTIFACT_RESOURCE,
  );
  clearTimeout(entry.timer);
  return entry.artifactPath;
}

export function cleanupUploadedArtifact(uploadId: string): void {
  const entry = pendingUploads().get(uploadId);
  if (!entry) return;
  clearTimeout(entry.timer);
  pendingUploads().delete(uploadId);
  fs.rmSync(entry.tempDir, { recursive: true, force: true });
}
