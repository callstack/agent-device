import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { emitDiagnostic } from '../../utils/diagnostics.ts';
import { AppError } from '../../utils/errors.ts';
import { acquireProcessLock } from '../../utils/process-lock.ts';
import { isProcessAlive, readProcessStartTime } from '../../utils/process-identity.ts';

const RUNNER_LEASE_SCHEMA_VERSION = 1;
const RUNNER_LEASE_LOCK_TIMEOUT_MS = 30_000;
const RUNNER_LEASE_LOCK_POLL_MS = 100;
const RUNNER_LEASE_OWNER_GRACE_MS = 5_000;

const RUNNER_OWNER_PID = process.pid;
export const RUNNER_OWNER_START_TIME = readProcessStartTime(process.pid);
export const RUNNER_OWNER_TOKEN = buildRunnerOwnerToken(RUNNER_OWNER_PID, RUNNER_OWNER_START_TIME);

export type RunnerLease = {
  schemaVersion: 1;
  deviceId: string;
  ownerToken: string;
  ownerPid: number;
  ownerStartTime: string | null;
  sessionId: string;
  runnerPid: number | null;
  port: number;
  xctestrunPath: string;
  jsonPath: string;
  createdAtMs: number;
};

type RunnerLeaseState =
  | { type: 'empty' }
  | { type: 'owned'; lease: RunnerLease }
  | { type: 'stale'; lease: RunnerLease }
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
    ownerToken: RUNNER_OWNER_TOKEN,
    ownerPid: RUNNER_OWNER_PID,
    ownerStartTime: RUNNER_OWNER_START_TIME,
    sessionId: params.sessionId,
    runnerPid: params.runnerPid ?? null,
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
      startTime: RUNNER_OWNER_START_TIME,
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
  if (lease.ownerToken === RUNNER_OWNER_TOKEN) return { type: 'owned', lease };
  return isRunnerLeaseOwnerAlive(lease) ? { type: 'busy', lease } : { type: 'stale', lease };
}

export async function prepareRunnerLeaseForStartup(
  deviceId: string,
  cleanup: RunnerLeaseCleanupAdapter,
): Promise<void> {
  const state = classifyRunnerLease(readRunnerLease(deviceId));
  if (state.type === 'empty') {
    await cleanup.cleanupRunnerXcodebuildProcesses(deviceId, undefined);
    return;
  }
  if (state.type === 'busy') {
    throw new AppError(
      'COMMAND_FAILED',
      `iOS runner for ${deviceId} is already owned by another agent-device daemon`,
      {
        deviceId,
        ownerPid: state.lease.ownerPid,
        ownerStartTime: state.lease.ownerStartTime,
        ownerToken: state.lease.ownerToken,
        sessionId: state.lease.sessionId,
        hint: 'Use a different simulator/session, wait for the other run to finish, or stop the owning daemon before retrying.',
      },
    );
  }
  await cleanupLeasedRunnerProcesses(state.lease, state.type, cleanup);
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
  const tmpPath = `${leasePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(lease, null, 2), 'utf8');
  fs.renameSync(tmpPath, leasePath);
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
  return path.join(os.homedir(), '.agent-device', 'ios-runner', 'leases');
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
    runnerPid: readPositiveInteger(raw.runnerPid),
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

function isRunnerLeaseOwnerAlive(lease: RunnerLease): boolean {
  if (!isProcessAlive(lease.ownerPid)) return false;
  if (lease.ownerStartTime) {
    return readProcessStartTime(lease.ownerPid) === lease.ownerStartTime;
  }
  return true;
}

async function cleanupLeasedRunnerProcesses(
  lease: RunnerLease,
  reason: 'owned' | 'stale',
  cleanup: RunnerLeaseCleanupAdapter,
): Promise<void> {
  emitDiagnostic({
    level: reason === 'stale' ? 'warn' : 'debug',
    phase: 'ios_runner_lease_cleanup',
    data: {
      deviceId: lease.deviceId,
      ownerPid: lease.ownerPid,
      ownerToken: lease.ownerToken,
      runnerPid: lease.runnerPid,
      sessionId: lease.sessionId,
      reason,
    },
  });
  await cleanup.cleanupRunnerProcessTree(lease.runnerPid ?? undefined, 'SIGTERM');
  await cleanup.cleanupRunnerXcodebuildProcesses(lease.deviceId, lease.ownerToken);
  await cleanup.cleanupRunnerProcessTree(lease.runnerPid ?? undefined, 'SIGKILL');
  cleanup.cleanupTempFile(lease.xctestrunPath);
  cleanup.cleanupTempFile(lease.jsonPath);
  releaseRunnerLease(lease);
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
