import { randomUUID } from 'node:crypto';
import {
  type AppleRunnerProvider,
  type RunnerSnapshotBridgeRequest,
  withAppleRunnerProvider,
} from '@agent-device/apple-runner';
import { emitDiagnostic, withDiagnosticTimer } from '@agent-device/host-kit/diagnostics';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import type { SnapshotSourceChannel } from '@agent-device/capture-kit/snapshot-router';
import { runAppleRunnerCommand } from './core/runner-client.ts';
import { hasSimulatorBridge } from './snapshot-observability.ts';
import {
  createSnapshotBridgeSource,
  type SnapshotBridgeSource,
} from './snapshot-source/bridge-source.ts';
import { remainingSnapshotSourceMs } from './snapshot-source/deadline.ts';
import { asSnapshotSourceError, snapshotSourceError } from './snapshot-source/errors.ts';
import {
  acceptSnapshotBridgeEnvelope,
  isRecord,
  type SnapshotBridgeEnvelope,
} from './snapshot-source/protocol.ts';

/** The app generation the runner-served bridge reads: one foreground process, for its whole life. */
export type RunnerSnapshotBridgeTarget = Readonly<{
  appBundleId: string;
  targetId: string;
  pid: number;
  processStartTime: string;
  generation: string;
}>;

/** Why the runner could not name the foreground process of the app: the bridge reader's own code. */
const TARGET_UNAVAILABLE = 'runner-snapshot-bridge-target-unavailable';

/** Bounds the target read, which costs one AXRuntime and two sysctl reads in the runner. */
const TARGET_READ_TIMEOUT_MS = 5_000;

/**
 * The part of a read's budget left for the transport. The runner abandons a read this much before the
 * daemon stops waiting, so a slow tree comes back as the reader's own refusal instead of a lost reply.
 */
const RUNNER_TRANSPORT_MARGIN_MS = 1_000;

/**
 * The runner-served bridge as a snapshot router channel. `resolveTarget` returns the cached target
 * without asking the runner, so the channel declares that its resolution does not verify identity.
 * The runner owns observe-only captures, and a new runner session drops every cached target.
 */
export type RunnerSnapshotBridge = SnapshotSourceChannel<RunnerSnapshotBridgeTarget> &
  Readonly<{ source: SnapshotBridgeSource<RunnerSnapshotBridgeTarget> }>;

/**
 * The Simulator AX bridge reader that the XCTest runner serves, for a Simulator whose host cannot
 * start the guest bridge process. The runner reads the tree off its XCTest main thread. A target stays
 * cached until a read reports a new process, so a steady tree read costs one runner round trip.
 */
export function createRunnerSnapshotBridge(
  options: Readonly<{ device: DeviceInfo; provider: AppleRunnerProvider }>,
): RunnerSnapshotBridge {
  let targets = new Map<string, RunnerSnapshotBridgeTarget>();
  // The runner admits one bridge read at a time and refuses an overlapping one at once, so it alone
  // owns that order: a read a cancelled capture left running costs the next capture its bridge read,
  // and the route answers that refusal for that capture only.
  const send = async (
    appBundleId: string,
    request: RunnerSnapshotBridgeRequest,
    signal: AbortSignal,
  ): Promise<SnapshotBridgeEnvelope> => {
    const data = await withAppleRunnerProvider(
      options.provider,
      { deviceId: options.device.id },
      async () =>
        await runAppleRunnerCommand(
          options.device,
          { command: 'snapshotBridge', appBundleId, snapshotBridge: request },
          { signal },
        ),
    );
    return parseRunnerEnvelope(data);
  };

  const refreshTarget: RunnerSnapshotBridge['refreshTarget'] = async (
    device,
    appBundleId,
    signal,
  ) => {
    signal.throwIfAborted();
    const targetId = `${device.id}:${appBundleId}`;
    // Only a resolved target replaces the cached one: a refresh that fails leaves the generation the
    // route planned against.
    const captureTargets = targets;
    const requestId = randomUUID();
    const envelope = await send(
      appBundleId,
      {
        verb: 'target',
        requestId,
        maxDurationMs: TARGET_READ_TIMEOUT_MS - RUNNER_TRANSPORT_MARGIN_MS,
      },
      AbortSignal.any([signal, AbortSignal.timeout(TARGET_READ_TIMEOUT_MS)]),
    );
    const target = readTarget(envelope, { requestId, appBundleId, targetId });
    captureTargets.set(targetId, target);
    return target;
  };
  const resolveTarget: RunnerSnapshotBridge['resolveTarget'] = async (
    device,
    appBundleId,
    signal,
  ) => {
    signal.throwIfAborted();
    return (
      targets.get(`${device.id}:${appBundleId}`) ??
      (await refreshTarget(device, appBundleId, signal))
    );
  };

  const source = createSnapshotBridgeSource<RunnerSnapshotBridgeTarget>({
    diagnostics: { emitDiagnostic, withDiagnosticTimer },
    transport: {
      name: 'runner',
      validateTarget,
      prepare: async (target) => async (read) => {
        const requestId = randomUUID();
        const remainingMs = remainingSnapshotSourceMs(read.deadline, 'bridge-request-deadline');
        const readDeadline = AbortSignal.timeout(remainingMs);
        let envelope: SnapshotBridgeEnvelope;
        try {
          envelope = await send(
            target.appBundleId,
            {
              verb: 'describe',
              requestId,
              generation: target.generation,
              expectedPid: target.pid,
              expectedProcessStartTime: target.processStartTime,
              maxDepth: read.maxDepth,
              maxNodes: read.limits.maxNodes,
              maxDurationMs: Math.max(1, read.limits.maxDurationMs - RUNNER_TRANSPORT_MARGIN_MS),
              maxResponseBytes: read.limits.maxResponseBytes,
              ...(read.nativeLevelsHint !== undefined
                ? { nativeLevelsHint: read.nativeLevelsHint }
                : {}),
              ...(read.surfaceHostExecutables
                ? { surfaceHostExecutables: read.surfaceHostExecutables }
                : {}),
            },
            AbortSignal.any([
              ...(read.deadline.signal ? [read.deadline.signal] : []),
              readDeadline,
            ]),
          );
        } catch (error) {
          throw runnerExchangeFailure(error, read.deadline.signal, readDeadline);
        }
        // A read that met a new process fails as a stale target; the route then refreshes the target,
        // which replaces the cached one.
        return acceptSnapshotBridgeEnvelope(envelope, {
          requestId,
          pid: target.pid,
          generation: target.generation,
        });
      },
      // The runner owns everything this transport reaches; the runner session closes it.
      close: async () => targets.clear(),
    },
  });
  return Object.freeze({
    source,
    servesDevice: hasSimulatorBridge,
    resolveTarget,
    refreshTarget,
    resolutionVerifiesIdentity: false,
    observeOnlySupported: false,
    circuit: {
      scope: 'runner-session' as const,
      sessionChanged: () => {
        targets = new Map();
      },
    },
  });
}

function parseRunnerEnvelope(data: Record<string, unknown>): SnapshotBridgeEnvelope {
  const text = data.snapshotBridgeEnvelope;
  if (typeof text !== 'string') {
    throw snapshotSourceError('malformed-tree', 'runner-envelope-missing');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw snapshotSourceError('malformed-tree', 'response-not-json', {}, error);
  }
  if (!isRecord(parsed)) throw snapshotSourceError('malformed-tree', 'response-not-object');
  return parsed;
}

function readTarget(
  envelope: SnapshotBridgeEnvelope,
  expected: Readonly<{ requestId: string; appBundleId: string; targetId: string }>,
): RunnerSnapshotBridgeTarget {
  const pid = envelope.pid;
  const processStartTime = envelope.processStartTime;
  if (
    envelope.requestId !== expected.requestId ||
    envelope.ok !== true ||
    typeof pid !== 'number' ||
    !Number.isSafeInteger(pid) ||
    pid <= 0 ||
    typeof processStartTime !== 'string' ||
    !processStartTime
  ) {
    const code = typeof envelope.error_code === 'string' ? envelope.error_code : 'target-invalid';
    if (code === 'bridge-reader-wedged')
      throw snapshotSourceError('timeout', 'bridge-reader-wedged');
    throw new AppError(
      'COMMAND_FAILED',
      `Unable to resolve the foreground app in the runner (${code}).`,
      {
        reason: TARGET_UNAVAILABLE,
        bridgeFailureCode: code,
        appBundleId: expected.appBundleId,
      },
    );
  }
  return Object.freeze({
    appBundleId: expected.appBundleId,
    targetId: expected.targetId,
    pid,
    processStartTime,
    generation: `${pid}:${processStartTime}`,
  });
}

function validateTarget(target: RunnerSnapshotBridgeTarget): void {
  if (
    !target.appBundleId.trim() ||
    !target.generation.trim() ||
    !Number.isSafeInteger(target.pid) ||
    target.pid <= 0
  ) {
    throw new AppError('INVALID_ARGS', 'Runner snapshot bridge target identity is incomplete');
  }
}

/**
 * A runner exchange that did not deliver an envelope. Only the caller's own cancellation is a
 * cancellation: a read that ran out of its own budget is a timeout, which the route answers with the
 * XCTest fallback. Any other failure is the runner transport's, treated like a guest transport failure.
 */
function runnerExchangeFailure(
  error: unknown,
  requestSignal: AbortSignal | undefined,
  readDeadline: AbortSignal,
) {
  if (requestSignal?.aborted) return snapshotSourceError('cancelled', 'abort-signal', {}, error);
  if (readDeadline.aborted) {
    return snapshotSourceError('timeout', 'bridge-request-deadline', {}, error);
  }
  const normalized = asSnapshotSourceError(error);
  if (normalized.failureKind !== 'transport-failure') return normalized;
  return snapshotSourceError(
    'transport-failure',
    'runner-exchange-failed',
    { error: error instanceof Error ? error.message : String(error) },
    error,
  );
}
