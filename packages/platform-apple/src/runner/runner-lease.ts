import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  emitDiagnostic,
  publishFileSync,
  acquireProcessLock,
  isProcessAlive,
  readProcessCommand,
  readProcessStartTime,
  classifyOwnerLiveness,
  leaseOwnerStateDir,
} from './host.ts';
import { AppError } from '@agent-device/kernel/errors';
import type { RunnerLogicalLeaseContext } from '@agent-device/contracts/runner-lease-context';

const RUNNER_LEASE_SCHEMA_VERSION = 1;
const RUNNER_LEASE_LOCK_TIMEOUT_MS = 30_000;
const RUNNER_LEASE_LOCK_POLL_MS = 100;
const RUNNER_LEASE_OWNER_GRACE_MS = 5_000;

const RUNNER_OWNER_PID = process.pid;

// Owner identity is resolved lazily: reading the process start time shells out
// through the host port, which is only bound once the client is constructed.
let cachedOwnerStartTime: { value: string | null } | undefined;
export function runnerOwnerStartTime(): string | null {
  cachedOwnerStartTime ??= { value: readProcessStartTime(process.pid) };
  return cachedOwnerStartTime.value;
}

export function runnerOwnerToken(): string {
  return buildRunnerOwnerToken(RUNNER_OWNER_PID, runnerOwnerStartTime());
}

export type RunnerLease = {
  schemaVersion: 1;
  deviceId: string;
  ownerToken: string;
  ownerPid: number;
  ownerStartTime: string | null;
  ownerStateDir?: string;
  sessionId: string;
  runnerPid: number | null;
  runnerStartTime?: string | null;
  port: number;
  xctestrunPath: string;
  jsonPath: string;
  createdAtMs: number;
};

// Why a foreign lease classifies as stale (reclaimable). The distinction is
// load-bearing: adoption (taking over a still-running runner without killing
// it) is only safe when the owner PROCESS is proven dead - a dir-gone-but-
// alive owner may still hold a live connection to the runner, so it must go
// through the force-stop path (kill runner processes, rebuild) instead.
type RunnerLeaseStaleReason =
  | 'owner-process-dead'
  | 'owner-process-reused'
  | 'owner-state-dir-gone';

type RunnerLeaseState =
  | { type: 'empty' }
  | { type: 'owned'; lease: RunnerLease }
  | { type: 'stale'; lease: RunnerLease; staleReason: RunnerLeaseStaleReason }
  | { type: 'busy'; lease: RunnerLease };

type RunnerLeaseRequiredFields = Pick<
  RunnerLease,
  'createdAtMs' | 'jsonPath' | 'ownerPid' | 'ownerToken' | 'port' | 'sessionId' | 'xctestrunPath'
>;

export type RunnerLeaseCleanupAdapter = {
  cleanupRunnerProcessTree(pid: number | undefined, signal: 'SIGTERM' | 'SIGKILL'): Promise<void>;
  cleanupRunnerXcodebuildProcesses(deviceId: string, ownerToken: string | undefined): Promise<void>;
  cleanupTempFile(filePath: string): void;
};

export function buildRunnerLease(params: {
  deviceId: string;
  sessionId: string;
  runnerPid: number | undefined;
  port: number;
  xctestrunPath: string;
  jsonPath: string;
}): RunnerLease {
  return {
    schemaVersion: RUNNER_LEASE_SCHEMA_VERSION,
    deviceId: params.deviceId,
    ownerToken: runnerOwnerToken(),
    ownerPid: RUNNER_OWNER_PID,
    ownerStartTime: runnerOwnerStartTime(),
    ownerStateDir: readCurrentStateDir(),
    sessionId: params.sessionId,
    runnerPid: params.runnerPid ?? null,
    runnerStartTime: params.runnerPid ? readProcessStartTime(params.runnerPid) : null,
    port: params.port,
    xctestrunPath: params.xctestrunPath,
    jsonPath: params.jsonPath,
    createdAtMs: Date.now(),
  };
}

export async function withRunnerLeaseLock<T>(deviceId: string, task: () => Promise<T>): Promise<T> {
  const release = await acquireProcessLock({
    lockDirPath: `${resolveRunnerLeasePath(deviceId)}.lock`,
    owner: {
      pid: RUNNER_OWNER_PID,
      startTime: runnerOwnerStartTime(),
      acquiredAtMs: Date.now(),
    },
    timeoutMs: RUNNER_LEASE_LOCK_TIMEOUT_MS,
    pollMs: RUNNER_LEASE_LOCK_POLL_MS,
    ownerGraceMs: RUNNER_LEASE_OWNER_GRACE_MS,
    description: `iOS runner lease for ${deviceId}`,
  });
  try {
    return await task();
  } finally {
    await release();
  }
}

function readRunnerLease(deviceId: string): RunnerLease | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(resolveRunnerLeasePath(deviceId), 'utf8')) as unknown;
    return normalizeRunnerLease(parsed, deviceId);
  } catch {
    return null;
  }
}

function classifyRunnerLease(lease: RunnerLease | null): RunnerLeaseState {
  if (!lease) return { type: 'empty' };
  if (lease.ownerToken === runnerOwnerToken()) return { type: 'owned', lease };
  const ownerLiveness = classifyOwnerLiveness({
    owner: { pid: lease.ownerPid, startTime: lease.ownerStartTime },
    ...(lease.ownerStateDir ? { stateDir: lease.ownerStateDir } : {}),
  });
  if (ownerLiveness !== 'live' && ownerLiveness !== 'unknown') {
    return { type: 'stale', lease, staleReason: ownerLiveness };
  }
  return { type: 'busy', lease };
}

export async function prepareRunnerLeaseForStartup(
  deviceId: string,
  cleanup: RunnerLeaseCleanupAdapter,
  logicalLeaseContext?: RunnerLogicalLeaseContext,
): Promise<void> {
  const state = classifyRunnerLease(readRunnerLease(deviceId));
  if (state.type === 'empty') {
    await cleanup.cleanupRunnerXcodebuildProcesses(deviceId, undefined);
    return;
  }
  if (state.type === 'busy') {
    if (isSameStateDirRunnerLease(state.lease)) {
      await cleanupLeasedRunnerProcesses(state.lease, 'same-state-dir', cleanup);
      return;
    }
    if (canLogicalLeaseReclaimRunner(state.lease, logicalLeaseContext)) {
      await cleanupLeasedRunnerProcesses(state.lease, 'logical-lease-takeover', cleanup);
      return;
    }
    throw new AppError(
      'COMMAND_FAILED',
      logicalLeaseContext
        ? `iOS runner for ${deviceId} is busy after device lease admission`
        : `iOS runner for ${deviceId} is already owned by another agent-device daemon`,
      {
        reason: 'IOS_RUNNER_OWNED_BY_OTHER_DAEMON',
        deviceId,
        logicalLeaseContext,
        ownerPid: state.lease.ownerPid,
        ownerStartTime: state.lease.ownerStartTime,
        ownerStateDir: state.lease.ownerStateDir,
        ownerToken: state.lease.ownerToken,
        sessionId: state.lease.sessionId,
        hint: buildBusyRunnerLeaseHint(state.lease, logicalLeaseContext),
      },
    );
  }
  await cleanupLeasedRunnerProcesses(state.lease, state.type, cleanup);
}

function isSameStateDirRunnerLease(lease: RunnerLease): boolean {
  // Same-state reclaim assumes callers sharing AGENT_DEVICE_STATE_DIR are the same logical daemon owner.
  const currentStateDir = readCurrentStateDir();
  if (!currentStateDir || !lease.ownerStateDir) return false;
  return path.resolve(currentStateDir) === path.resolve(lease.ownerStateDir);
}

function canLogicalLeaseReclaimRunner(
  lease: RunnerLease,
  logicalLeaseContext: RunnerLogicalLeaseContext | undefined,
): boolean {
  if (!logicalLeaseContext || logicalLeaseContext.leaseProvider !== 'proxy') return false;
  if (!logicalLeaseContext.leaseId || !logicalLeaseContext.clientId) return false;
  return logicalLeaseContextMatchesDevice(logicalLeaseContext.deviceKey, lease.deviceId);
}

function logicalLeaseContextMatchesDevice(
  logicalDeviceKey: string | undefined,
  runnerDeviceId: string,
): boolean {
  if (!logicalDeviceKey) return false;
  if (logicalDeviceKey === runnerDeviceId) return true;
  const [, , canonicalDeviceId] = logicalDeviceKey.split(':', 3);
  return canonicalDeviceId === runnerDeviceId;
}

function readCurrentStateDir(): string | undefined {
  const configured = leaseOwnerStateDir();
  if (configured) return configured;
  return process.env.AGENT_DEVICE_STATE_DIR?.trim() || undefined;
}

function buildBusyRunnerLeaseHint(
  lease: RunnerLease,
  logicalLeaseContext?: RunnerLogicalLeaseContext,
): string {
  const owner = buildRunnerOwnerHint(lease);
  const cleanup = buildBusyRunnerLeaseCleanupHint(lease);
  if (logicalLeaseContext) {
    return [
      cleanup,
      owner,
      'The device is busy because another active device lease owns it, or the runner is owned by another daemon/process after lease admission.',
      'Retry after the owning session closes or after the five-minute inactivity lease expires.',
    ].join(' ');
  }
  return [
    cleanup,
    owner,
    'If the runner is still active, wait for it to finish. Do not run prepare ios-runner from another daemon/client to recover this.',
  ].join(' ');
}

function buildRunnerOwnerHint(lease: RunnerLease): string {
  const owner = `Runner owner: PID ${lease.ownerPid}`;
  if (lease.ownerStateDir) return `${owner} with AGENT_DEVICE_STATE_DIR=${lease.ownerStateDir}`;
  return `${owner}.`;
}

function buildBusyRunnerLeaseCleanupHint(lease: RunnerLease): string {
  if (lease.ownerStateDir) {
    return `If it is stuck, stop the owning agent-device daemon for ${formatEnvAssignment('AGENT_DEVICE_STATE_DIR', lease.ownerStateDir)} and retry.`;
  }
  return 'If it is stuck, stop the owning agent-device daemon and retry.';
}

function formatEnvAssignment(name: string, value: string): string {
  return `${name}=${shellQuote(value)}`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", String.raw`'\''`)}'`;
}

// A lease whose owner process is gone but whose runner may still be running:
// the adoption path probes it instead of killing it. Detached leases (graceful
// daemon shutdown rewrote the token) classify as stale too once the owner pid
// dies, so crash-orphans and deliberate handoffs share one recovery path.
// Adoption is strictly PID-dead-gated: an owner whose state dir is gone but
// whose process is still alive may still hold a live connection to the
// runner, so adopting it would create two masters. Those leases return null
// here and go through prepareRunnerLeaseForStartup's force-stop path (kill
// the leased runner processes, then rebuild) instead.
export function readStaleRunnerLease(deviceId: string): RunnerLease | null {
  const state = classifyRunnerLease(readRunnerLease(deviceId));
  return state.type === 'stale' &&
    (state.staleReason === 'owner-process-dead' || state.staleReason === 'owner-process-reused')
    ? state.lease
    : null;
}

// Marks a lease as handed off during graceful shutdown: the token no longer
// matches this daemon, so the shutdown's own lease-cleanup paths skip it, and
// once this process exits the lease classifies as stale for the next adopter.
export function buildDetachedRunnerLease(lease: RunnerLease): RunnerLease {
  return { ...lease, ownerToken: `detached-${lease.ownerToken}` };
}

export async function cleanupOwnedRunnerLease(
  deviceId: string,
  cleanup: RunnerLeaseCleanupAdapter,
): Promise<void> {
  const state = classifyRunnerLease(readRunnerLease(deviceId));
  if (state.type === 'owned') {
    await cleanupLeasedRunnerProcesses(state.lease, 'owned', cleanup);
  }
}

export async function cleanupRunnerLeasesForOwner(
  owner: { pid: number; startTime?: string | null },
  cleanup: RunnerLeaseCleanupAdapter,
): Promise<void> {
  if (!Number.isInteger(owner.pid) || owner.pid <= 0) return;
  const leases = listRunnerLeasesForOwner(owner);
  await Promise.all(
    leases.map(async (lease) => {
      await cleanupLeasedRunnerProcesses(lease, 'owned', cleanup);
    }),
  );
}

export function releaseRunnerLease(lease: RunnerLease | undefined): void {
  if (!lease) return;
  removeRunnerLease({
    deviceId: lease.deviceId,
    ownerToken: lease.ownerToken,
    sessionId: lease.sessionId,
  });
}

export function writeRunnerLease(lease: RunnerLease): void {
  const leasePath = resolveRunnerLeasePath(lease.deviceId);
  fs.mkdirSync(path.dirname(leasePath), { recursive: true });
  publishFileSync({
    destination: leasePath,
    contents: JSON.stringify(lease, null, 2),
  });
}

function removeRunnerLease(params: {
  deviceId: string;
  ownerToken?: string;
  sessionId?: string;
}): void {
  const lease = readRunnerLease(params.deviceId);
  if (!lease) return;
  if (params.ownerToken && lease.ownerToken !== params.ownerToken) return;
  if (params.sessionId && lease.sessionId !== params.sessionId) return;
  try {
    fs.unlinkSync(resolveRunnerLeasePath(params.deviceId));
  } catch {}
}

function resolveRunnerLeasePath(deviceId: string): string {
  return path.join(resolveRunnerLeaseRoot(), `${sanitizeLeaseFileName(deviceId)}.json`);
}

function resolveRunnerLeaseRoot(): string {
  const override = process.env.AGENT_DEVICE_IOS_RUNNER_LEASE_DIR?.trim();
  if (override) return path.resolve(override);
  return path.join(os.homedir(), '.agent-device', 'apple-runner', 'leases');
}

function listRunnerLeasesForOwner(owner: {
  pid: number;
  startTime?: string | null;
}): RunnerLease[] {
  let entries: fs.Dirent[];
  const root = resolveRunnerLeaseRoot();
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const leases: RunnerLease[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const lease = readRunnerLeaseFile(path.join(root, entry.name));
    if (!lease) continue;
    if (lease.ownerPid !== owner.pid) continue;
    if (owner.startTime !== undefined && lease.ownerStartTime !== owner.startTime) continue;
    leases.push(lease);
  }
  return leases;
}

function readRunnerLeaseFile(filePath: string): RunnerLease | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<RunnerLease>;
    const deviceId = readNonEmptyString(parsed.deviceId);
    return deviceId ? normalizeRunnerLease(parsed, deviceId) : null;
  } catch {
    return null;
  }
}

function normalizeRunnerLease(value: unknown, deviceId: string): RunnerLease | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Partial<RunnerLease>;
  if (raw.schemaVersion !== RUNNER_LEASE_SCHEMA_VERSION) return null;
  if (raw.deviceId !== deviceId) return null;
  const fields = readRunnerLeaseRequiredFields(raw);
  if (!fields) return null;
  return {
    schemaVersion: RUNNER_LEASE_SCHEMA_VERSION,
    deviceId,
    ...fields,
    ownerStartTime: readOptionalString(raw.ownerStartTime),
    ownerStateDir: readOptionalString(raw.ownerStateDir) ?? undefined,
    runnerPid: readPositiveInteger(raw.runnerPid),
    runnerStartTime: readOptionalString(raw.runnerStartTime),
  };
}

function readRunnerLeaseRequiredFields(
  raw: Partial<RunnerLease>,
): RunnerLeaseRequiredFields | null {
  const fields = {
    ownerToken: readNonEmptyString(raw.ownerToken),
    ownerPid: readPositiveInteger(raw.ownerPid),
    sessionId: readNonEmptyString(raw.sessionId),
    port: readPositiveInteger(raw.port),
    xctestrunPath: readNonEmptyString(raw.xctestrunPath),
    jsonPath: readNonEmptyString(raw.jsonPath),
    createdAtMs: readFiniteNumber(raw.createdAtMs),
  };
  if (Object.values(fields).some((field) => field === null)) return null;
  return fields as RunnerLeaseRequiredFields;
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readOptionalString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function readPositiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

function readFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

// A lease owner counts as gone - and its lease reclaimable as stale - when its
// PID is dead/recycled OR its
// AGENT_DEVICE_STATE_DIR no longer exists on disk (owner-state-dir-gone). The
// state-dir check covers daemons left running by a deleted sandbox/worktree:
// the process is technically still alive, but nothing can ever route a request
// to it again (its info/lock/session files are gone with the directory), so it
// can never legitimately contend for the runner. Leases written before this
// field existed (no ownerStateDir) skip the check and fall back to PID
// liveness only.
async function cleanupLeasedRunnerProcesses(
  lease: RunnerLease,
  reason: 'owned' | 'stale' | 'same-state-dir' | 'logical-lease-takeover',
  cleanup: RunnerLeaseCleanupAdapter,
): Promise<void> {
  emitDiagnostic({
    level:
      reason === 'stale' || reason === 'same-state-dir' || reason === 'logical-lease-takeover'
        ? 'warn'
        : 'debug',
    phase: 'ios_runner_lease_cleanup',
    data: {
      deviceId: lease.deviceId,
      ownerPid: lease.ownerPid,
      ownerStateDir: lease.ownerStateDir,
      ownerToken: lease.ownerToken,
      runnerPid: lease.runnerPid,
      sessionId: lease.sessionId,
      reason,
    },
  });
  await cleanup.cleanupRunnerProcessTree(resolveVerifiedLeaseRunnerPid(lease), 'SIGTERM');
  await cleanup.cleanupRunnerXcodebuildProcesses(lease.deviceId, lease.ownerToken);
  await cleanup.cleanupRunnerProcessTree(resolveVerifiedLeaseRunnerPid(lease), 'SIGKILL');
  cleanup.cleanupTempFile(lease.xctestrunPath);
  cleanup.cleanupTempFile(lease.jsonPath);
  releaseRunnerLease(lease);
}

/**
 * A lease file can outlive its runner by days (SIGKILLed daemon), and pids are
 * recycled — killing `lease.runnerPid` raw would signal whatever process now
 * holds that pid, including its whole process group (#1596). Only return the
 * pid when the live process is provably still the leased runner. Callers must
 * resolve immediately before each signal and never reuse a resolved pid across
 * an await: the runner usually dies on SIGTERM, and its pid can be recycled
 * while the awaited xcodebuild sweep runs before the SIGKILL escalation. The
 * pattern-based xcodebuild pkill in the cleanup adapter is unaffected and
 * still collects genuinely stray runner processes.
 */
function resolveVerifiedLeaseRunnerPid(lease: RunnerLease): number | undefined {
  const pid = lease.runnerPid ?? undefined;
  if (!pid || !isProcessAlive(pid)) return undefined;
  if (verifyLeaseRunnerPidIdentity(lease, pid)) return pid;
  emitDiagnostic({
    level: 'warn',
    phase: 'ios_runner_lease_recycled_pid_skipped',
    data: {
      deviceId: lease.deviceId,
      runnerPid: pid,
      runnerStartTime: lease.runnerStartTime ?? null,
      sessionId: lease.sessionId,
    },
  });
  return undefined;
}

/**
 * Is the live process holding `pid` provably still the runner this lease
 * recorded? Matching recorded start time, or — for leases written before
 * `runnerStartTime` existed — a command line that looks like the runner's
 * xcodebuild. Shared with adoption: an unverified pid must never be adopted,
 * because adoption re-stamps the lease with the live pid's start time and
 * would launder a recycled pid into a strongly-verified lease that disposal
 * later kills (#1596).
 */
export function verifyLeaseRunnerPidIdentity(lease: RunnerLease, pid: number): boolean {
  return lease.runnerStartTime
    ? readProcessStartTime(pid) === lease.runnerStartTime
    : isRunnerXcodebuildCommand(readProcessCommand(pid));
}

function isRunnerXcodebuildCommand(command: string | null): boolean {
  return !!command && command.includes('xcodebuild') && command.includes('AgentDeviceRunner');
}

function buildRunnerOwnerToken(pid: number, startTime: string | null): string {
  const hash = crypto.createHash('sha256');
  hash.update(String(pid));
  hash.update('\0');
  hash.update(startTime ?? 'unknown-start');
  return `owner-${pid}-${hash.digest('hex').slice(0, 8)}`;
}

function sanitizeLeaseFileName(value: string): string {
  return value.replaceAll(/[^A-Za-z0-9._-]/g, '-') || 'unknown-device';
}
