// The seam between the transport and the remote resend rules. Declared below both, so neither
// imports the other's types and the two stay readable in isolation.
import type { DaemonResponse } from '@agent-device/kernel/contracts';
import type { DaemonCapability } from '@agent-device/daemon-contracts/daemon-resolution';
import type { DaemonInfo } from './daemon-client-metadata.ts';

/** The `/health` facts the resend rules read; the transport's health answer has this shape. */
export type RemoteResendHealth = {
  reachable: boolean;
  timedOut?: true;
  instanceId?: string;
  capabilities?: readonly DaemonCapability[];
  upstream?: { instanceId?: string; capabilities?: readonly DaemonCapability[] };
};

/** The transport's side of one failed send: how to probe, resend and refuse for that request. */
export type RemoteResendPort = {
  info: DaemonInfo;
  /** The command's budget and its end on the `performance.now()` clock, when it has one. */
  timeoutMs: number | undefined;
  deadline: number | undefined;
  signal: AbortSignal | undefined;
  /** Sends the request once more, with `timeoutMs` as its budget. */
  resend(timeoutMs: number | undefined): Promise<DaemonResponse>;
  /** A live `/health` read that refuses a skewed protocol. */
  readHealth(probeTimeoutMs: number | undefined): Promise<RemoteResendHealth>;
  /** A `/health` read through the process cache, as the recovery loop probes. */
  probeHealth(probeTimeoutMs: number, signal: AbortSignal | undefined): Promise<RemoteResendHealth>;
  invalidateHealth(): Promise<void>;
  /** Throws the typed cancellation when the caller has aborted. */
  refuseIfAborted(): void;
  /** The timeout refusal for a budget spent before anything was resent. */
  budgetSpent(): Error;
  /** Whether a failure is a transport failure that makes the cached health stale. */
  isTransportFailure(error: unknown): boolean;
  /** The `/health` probe's own time limit. */
  healthProbeTimeoutMs: number;
};
