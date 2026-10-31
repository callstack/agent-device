import { inspectProcessLock } from '@agent-device/host-kit/file';
import { isProcessPid } from '@agent-device/host-kit/process';

import type { DaemonCodeOrigin } from '@agent-device/host-kit/code-signature';
import {
  readDaemonCapabilities,
  readDaemonOwnership,
  readDaemonRecord,
  readRecordedDaemonTransport,
  type DaemonCapability,
  type DaemonOwnership,
  type DaemonPaths,
  type DaemonTransportPreference,
  type DaemonServerMode,
  type ObservedDaemonIdentity,
} from '@agent-device/daemon-contracts/daemon-resolution';

export type DaemonInfo = {
  port?: number;
  httpPort?: number;
  transport?: DaemonServerMode;
  token: string;
  pid: number;
  version?: string;
  codeOrigin?: DaemonCodeOrigin;
  codeSignature?: string;
  processStartTime?: string;
  /** ADR 0029: digest of the daemon policy the daemon enforces; absent when it has none. */
  policyDigest?: string;
  /** Absent from daemons that predate capabilities, which therefore have none. */
  capabilities?: readonly DaemonCapability[];
  /**
   * Who owns the process this record names, and so who may end it. A record that predates the field
   * is a detached daemon, which is why an absent value means exactly that.
   */
  ownership?: DaemonOwnership;
  /** The provider plugin inventory as published; `readPluginInventory` validates it where it is read. */
  plugins?: unknown;
  baseUrl?: string;
  remoteInstanceId?: string;
  remoteUpstreamInstanceId?: string;
};

/**
 * Why a daemon is not the one this client would use. `transport` means alive but not on the
 * transport this client uses: the ladder only ever answers `unreachable` for it, and a caller that
 * must not kill a live daemon refines it with `observeLocalDaemon`.
 */
export type DaemonTakeoverCause = 'version' | 'code' | 'transport' | 'unreachable';

/** What to do with the daemon already running on this state directory. */
export type DaemonTakeoverDecision =
  | { kind: 'reuse' }
  | { kind: 'replace'; reason: string; cause: DaemonTakeoverCause }
  | { kind: 'refuseNewer'; daemonVersion: string; clientVersion: string };

export type DaemonObservationSettings = {
  paths: DaemonPaths;
  transportPreference: DaemonTransportPreference;
};

export type DaemonObservationOptions = {
  deadline?: number;
  waitForLiveStartup?: boolean;
  refineUnreachable?: boolean;
};

export type LocalDaemonObservation = {
  info: DaemonInfo;
  decision: DaemonTakeoverDecision;
};

/**
 * Reads the admitted registration without starting or compatibility-checking a daemon.
 * Missing or foreign registrations return null; `required: true` uses the normal not-running error.
 * An unproven registration always uses the normal ownership refusal.
 */
export function readRegisteredDaemon(
  paths: DaemonPaths,
  options: { required: true },
): Promise<DaemonInfo>;
export function readRegisteredDaemon(
  paths: DaemonPaths,
  options?: { required?: boolean },
): Promise<DaemonInfo | null>;
export async function readRegisteredDaemon(
  paths: DaemonPaths,
  options: { required?: boolean } = {},
): Promise<DaemonInfo | null> {
  const { processLockHoldsDaemonIdentity } =
    await import('@agent-device/daemon-contracts/daemon-registration');
  const inspection = inspectProcessLock(paths.lockPath);
  if (inspection.state === 'unproven') {
    const { daemonRegistrationUnprovenError } = await import('./daemon-lifecycle-errors.ts');
    throw daemonRegistrationUnprovenError(paths, inspection);
  }
  let info = readDaemonInfo(paths.infoPath);
  if (info && inspection.state !== 'absent') {
    if (
      !processLockHoldsDaemonIdentity(inspection, {
        pid: info.pid,
        startTime: info.processStartTime ?? null,
      })
    )
      info = null;
  }
  if (!info && options.required) {
    const { daemonNotRunningError } = await import('./daemon-lifecycle-errors.ts');
    throw daemonNotRunningError(paths.baseDir);
  }
  return info;
}

export function readDaemonInfo(infoPath: string): DaemonInfo | null {
  const read = readDaemonRecord(infoPath);
  if (read.status !== 'present') return null;
  const parsed = read.record;
  const token = readRequiredDaemonToken(parsed);
  const ports = readDaemonInfoPorts(parsed);
  const pid = parsed.pid;
  return token && ports && isProcessPid(pid)
    ? readDaemonInfoFromRecord(parsed, token, ports, pid)
    : null;
}

/**
 * The observation a retirement judges, from a record this client already read. Ownership travels with
 * the lifetime because a retirement signals only a process its record proves is a daemon of its own, and
 * a client that read the record once should not read it again to answer that.
 */
export function observedDaemonIdentityOf(info: DaemonInfo): ObservedDaemonIdentity {
  return {
    pid: info.pid,
    startTime: info.processStartTime ?? null,
    ownership: readDaemonOwnership(info.ownership),
  };
}

function readDaemonInfoFromRecord(
  parsed: Partial<DaemonInfo>,
  token: string,
  ports: Pick<DaemonInfo, 'port' | 'httpPort'>,
  pid: number,
): DaemonInfo {
  return {
    token,
    ...ports,
    transport: readRecordedDaemonTransport(parsed.transport),
    pid,
    version: readOptionalString(parsed.version),
    codeOrigin: readDaemonInfoCodeOrigin(parsed.codeOrigin),
    codeSignature: readOptionalString(parsed.codeSignature),
    processStartTime: readOptionalString(parsed.processStartTime),
    policyDigest: readOptionalString(parsed.policyDigest),
    capabilities: readDaemonCapabilities(parsed.capabilities),
    ownership: readDaemonOwnership(parsed.ownership),
    ...(Array.isArray(parsed.plugins) ? { plugins: parsed.plugins } : {}),
  };
}

function readRequiredDaemonToken(parsed: Partial<DaemonInfo>): string | null {
  return typeof parsed.token === 'string' && parsed.token.length > 0 ? parsed.token : null;
}

function readDaemonInfoPorts(
  parsed: Partial<DaemonInfo>,
): Pick<DaemonInfo, 'port' | 'httpPort'> | null {
  const port = readDaemonPort(parsed.port);
  const httpPort = readDaemonPort(parsed.httpPort);
  if (port === undefined && httpPort === undefined) return null;
  return { port, httpPort };
}

function readDaemonInfoCodeOrigin(value: unknown): DaemonInfo['codeOrigin'] {
  return value === 'installed' || value === 'checkout' ? value : undefined;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function readDaemonPort(value: unknown): number | undefined {
  return Number.isInteger(value) && Number(value) > 0 && Number(value) <= 65_535
    ? Number(value)
    : undefined;
}

export function isRemoteDaemon(info: DaemonInfo): boolean {
  return typeof info.baseUrl === 'string' && info.baseUrl.length > 0;
}
