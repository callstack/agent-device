import { PUBLIC_COMMANDS } from '@agent-device/command-registry/catalog';
import {
  commandMeetsLeaseAdmission,
  isDelegatingCompositeCommand,
} from '@agent-device/command-registry/registry';
import {
  isUndispatchedInactiveLeaseRefusal,
  leaseProviderRequiringRuntime,
  requireLeaseDeviceSpec,
} from '@agent-device/contracts/lease-scope';
import { DAEMON_CAPABILITY_REFUSAL_REASONS } from '@agent-device/daemon-contracts/daemon-resolution';
import {
  buildRemoteConnectionRequestMetadata,
  type RemoteConnectionState,
} from '@agent-device/remote/remote-connection-state';
import type { Lease } from '@agent-device/contracts/client';
import type { CliFlags } from '@agent-device/contracts/command';
import type { LeaseBackend } from '@agent-device/kernel/contracts';
import type { sendToDaemon } from '@agent-device/daemon-client';
import type { ConnectionLeasePolicy } from './connection-lease-policy.ts';

// A reused lease is checked either by a heartbeat before the command or by the daemon when it admits
// the command. Admission refuses an inactive lease before dispatch with `dispatched: no`, and the
// daemon-client refuses before the send a daemon whose `/health` lacks `lease-admission`. On either
// refusal of the command's only request, the CLI materializes the connection again and reruns it.

/** How the CLI checks the lease it reuses for one command. */
export type ReusedLeaseCheck = Readonly<{
  /** Let the command's admission check the lease instead of a heartbeat, where that is safe. */
  byAdmission: boolean;
  /** The lease the daemon refused at admission. It is reallocated without a heartbeat. */
  inactiveLeaseId?: string;
}>;

/** A reused lease that the command's admission checks and renews instead of a heartbeat. */
export type AdmissionCheckedLease = Readonly<{
  leaseId: string;
  /** The window the heartbeat would have named; the command names it so admission renews the same. */
  leaseTtlMs?: number;
}>;

/** Commands whose request uploads a local artifact first; the upload's own beat needs a live lease. */
const ARTIFACT_UPLOAD_COMMANDS: ReadonlySet<string> = new Set([
  PUBLIC_COMMANDS.install,
  PUBLIC_COMMANDS.reinstall,
  PUBLIC_COMMANDS.installFromSource,
]);

/**
 * The reused lease the command's own admission can check, or `undefined` when a heartbeat must. The
 * heartbeat stays wherever it does more than admission does:
 * - a host-allocated `macos-app` lease has its own refusal;
 * - a provider with a runtime runs lifecycle hooks on a heartbeat, such as an instance liveness check;
 * - a command exempt from lease admission is never checked there;
 * - an upload of a local artifact runs before admission, under the lease;
 * - a composite (`batch`, `replay`, `test`) reads local scripts while it builds its request, and a
 *   rerun could not read a pipe again;
 * - `--save-script` records its publication before the send;
 * - a by-spec allocation binds the device from the heartbeat answer, unless the connection already
 *   names the device and the request names no other device or spec.
 */
export function leaseCheckedByAdmission(
  options: Readonly<{
    command: string;
    state: RemoteConnectionState;
    flags: CliFlags;
    leaseBackend: LeaseBackend;
    policy: ConnectionLeasePolicy;
    allocateBySpec: boolean | undefined;
    check: ReusedLeaseCheck | undefined;
  }>,
): AdmissionCheckedLease | undefined {
  const { state, flags, check } = options;
  if (
    !check?.byAdmission ||
    !state.leaseId ||
    state.leaseBackend !== options.leaseBackend ||
    state.leaseBackend === 'macos-app' ||
    leaseProviderRequiringRuntime({ leaseProvider: state.leaseProvider }) !== undefined ||
    !commandMeetsLeaseAdmission(options.command) ||
    ARTIFACT_UPLOAD_COMMANDS.has(options.command) ||
    isDelegatingCompositeCommand({ command: options.command, positionals: [] }) ||
    flags.saveScript !== undefined ||
    (options.allocateBySpec && !bindsStoredDevice(state, flags))
  ) {
    return undefined;
  }
  const leaseTtlMs = options.policy.ttlMs(state);
  return { leaseId: state.leaseId, ...(leaseTtlMs === undefined ? {} : { leaseTtlMs }) };
}

/** Whether binding would take the stored device as it is: the request names no device or spec. */
function bindsStoredDevice(state: RemoteConnectionState, flags: CliFlags): boolean {
  return (
    state.deviceKey !== undefined &&
    requireLeaseDeviceSpec(flags).keys.length === 0 &&
    flags.udid === undefined &&
    flags.serial === undefined &&
    flags.device === undefined &&
    flags.iosSimulatorDeviceSet === undefined &&
    flags.androidDeviceAllowlist === undefined
  );
}

/** The lease a connection already names, as the heartbeat would have answered it. */
export function leaseOfConnection(
  state: RemoteConnectionState,
  leaseId: string,
  leaseBackend: LeaseBackend,
): Lease {
  return {
    leaseId,
    tenantId: state.tenant,
    runId: state.runId,
    backend: leaseBackend,
    ...buildRemoteConnectionRequestMetadata(state),
  };
}

type DaemonTransport = typeof sendToDaemon;

/** How the requests of a command that relies on admission fared. */
type LeaseAdmissionAttempt = {
  requests: number;
  /** Set when the first request was refused before its send or its dispatch. */
  firstRefusal?: 'inactive-lease' | 'unsupported';
};

/** Sends each request marked as admission-checked, and records how the first one was refused. */
function leaseAdmissionTransport(
  send: DaemonTransport,
  attempt: LeaseAdmissionAttempt,
): DaemonTransport {
  return async (req, options) => {
    attempt.requests += 1;
    const first = attempt.requests === 1;
    try {
      const response = await send(req, { ...options, leaseCheckedByAdmission: true });
      if (first && !response.ok) attempt.firstRefusal = refusalOf(response.error);
      return response;
    } catch (error) {
      if (first) attempt.firstRefusal = refusalOf(error);
      throw error;
    }
  };
}

function refusalOf(error: unknown): LeaseAdmissionAttempt['firstRefusal'] {
  if (isUndispatchedInactiveLeaseRefusal(error)) return 'inactive-lease';
  const reason = (error as Readonly<{ details?: Readonly<{ reason?: unknown }> }> | null)?.details
    ?.reason;
  return reason === DAEMON_CAPABILITY_REFUSAL_REASONS.leaseAdmissionUnsupported.reason
    ? 'unsupported'
    : undefined;
}

/**
 * The lease check a rerun uses, or `undefined` when the failure stands. A rerun is safe only when the
 * command sent one request and it was refused before dispatch, so nothing of the command ran. An
 * inactive lease is reallocated; a daemon without `lease-admission` gets the heartbeat.
 */
function leaseCheckAfterRefusal(
  attempt: LeaseAdmissionAttempt | undefined,
  refused: AdmissionCheckedLease | undefined,
): ReusedLeaseCheck | undefined {
  if (!attempt || !refused || attempt.requests !== 1) return undefined;
  if (attempt.firstRefusal === 'inactive-lease') {
    return { byAdmission: false, inactiveLeaseId: refused.leaseId };
  }
  return attempt.firstRefusal === 'unsupported' ? { byAdmission: false } : undefined;
}

/**
 * Dispatches a command whose reused lease admission checks, and reruns it once after a refusal that
 * {@link leaseCheckAfterRefusal} admits, with the connection materialized again by `rematerialize`.
 */
export async function dispatchWithLeaseAdmission(
  admissionChecked: AdmissionCheckedLease | undefined,
  transport: DaemonTransport,
  steps: Readonly<{
    dispatch: (transport: DaemonTransport) => Promise<void>;
    rematerialize: (check: ReusedLeaseCheck) => Promise<void>;
  }>,
): Promise<void> {
  const attempt: LeaseAdmissionAttempt | undefined = admissionChecked ? { requests: 0 } : undefined;
  try {
    await steps.dispatch(attempt ? leaseAdmissionTransport(transport, attempt) : transport);
  } catch (error) {
    const check = leaseCheckAfterRefusal(attempt, admissionChecked);
    if (!check) throw error;
    await steps.rematerialize(check);
    await steps.dispatch(transport);
  }
}
