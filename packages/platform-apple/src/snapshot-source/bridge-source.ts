import { AppError } from '@agent-device/kernel/errors';
import { observeCompleteTreeKeyboard } from '@agent-device/contracts/tap-keyboard-occlusion';
import type {
  CaptureHint,
  IosSnapshotAcquisition,
  IosViewportEvidence,
} from '@agent-device/contracts/ios-snapshot';
import {
  createSnapshotSourceDeadline,
  remainingSnapshotSourceMs,
  type SnapshotSourceDeadline,
} from './deadline.ts';
import { AcceptedDepthHints, type DepthHintDecision } from './depth-hints.ts';
import { asSnapshotSourceError, snapshotSourceError } from './errors.ts';
import { resolveSnapshotSourceLimits } from './limits.ts';
import { readSnapshotBridgeRecovery, type SnapshotBridgeEnvelope } from './protocol.ts';
import { decodeSnapshotBridgeTree } from './tree.ts';
import type { SnapshotSourceOutcome } from '@agent-device/capture-kit/snapshot-source-channel';
import type {
  SnapshotBridgeSourceRequest,
  SnapshotBridgeTarget,
  SnapshotSourceHost,
  SnapshotSourceLimits,
} from './types.ts';

/**
 * The producer every bridge read reports, whichever process read the tree: the guest bridge on a local
 * Simulator and the runner serve one reader, so their trees compare as one producer.
 */
export const SNAPSHOT_BRIDGE_PRODUCER = 'simulator-ax-bridge' as const;

/** One accepted bridge reply for one bounded read. */
export type SnapshotBridgeExchange = (
  input: Readonly<{
    limits: SnapshotSourceLimits;
    maxDepth: number;
    nativeLevelsHint?: number;
    /** The system surface host executables whose running process refuses the read (#2751). */
    surfaceHostExecutables?: readonly string[];
    deadline: SnapshotSourceDeadline;
  }>,
) => Promise<SnapshotBridgeEnvelope>;

/** How one process that serves the bridge reader is reached. */
export type SnapshotBridgeTransport<Target extends SnapshotBridgeTarget> = Readonly<{
  /** Labels the transport in the acquisition diagnostics. */
  name: 'guest-process' | 'runner';
  /** Throws `INVALID_ARGS` for a target this transport cannot address. */
  validateTarget(target: Target): void;
  /**
   * Readies the transport for one read of `target`. It runs before the read spends a depth hint, so
   * a read the transport could not start costs the hint nothing.
   */
  prepare(target: Target, deadline: SnapshotSourceDeadline): Promise<SnapshotBridgeExchange>;
  /** Ends what the transport owns. Runs once, after the source refuses new reads. */
  close(): Promise<void>;
}>;

export type SnapshotBridgeSource<Target extends SnapshotBridgeTarget> = Readonly<{
  acquire(request: SnapshotBridgeSourceRequest<Target>): Promise<SnapshotSourceOutcome>;
  close(): Promise<void>;
}>;

/**
 * The bridge read a transport does not decide: bounds, depth hints, the envelope's acquisition, and
 * the recovery record. A transport supplies only how one accepted envelope arrives, so a tree means
 * the same thing whether the guest bridge or the runner read it.
 */
export function createSnapshotBridgeSource<Target extends SnapshotBridgeTarget>(
  options: Readonly<{
    diagnostics: Pick<SnapshotSourceHost, 'emitDiagnostic' | 'withDiagnosticTimer'>;
    limits?: Partial<SnapshotSourceLimits>;
    transport: SnapshotBridgeTransport<Target>;
  }>,
): SnapshotBridgeSource<Target> {
  const transport = options.transport;
  const depthHints = new AcceptedDepthHints();
  const diagnostics = options.diagnostics;
  let closed = false;
  let closing: Promise<void> | undefined;

  const acquire = async (
    request: SnapshotBridgeSourceRequest<Target>,
  ): Promise<SnapshotSourceOutcome> => {
    try {
      if (closed) throw snapshotSourceError('unsupported', 'source-closed');
      transport.validateTarget(request.target);
      validateHint(request.hint);
      const limits = resolveSnapshotSourceLimits({ ...options.limits, ...request.limits });
      const deadline = createSnapshotSourceDeadline(limits.maxDurationMs, request.signal);
      const maxDepth = resolveRequestedDepth(request.hint, limits.maxTraversalDepth);
      const requestedLevels = maxDepth + 1;
      const explicitDepth = request.hint.rawTraversalDepth !== null;
      return await diagnostics.withDiagnosticTimer(
        'ios.snapshot-source.acquire',
        async () => {
          const exchange = await transport.prepare(request.target, deadline);
          const decision = depthHints.consume(request.target, requestedLevels, explicitDepth);
          const envelope = await exchange({
            limits,
            maxDepth,
            ...(decision.nativeLevels !== undefined
              ? { nativeLevelsHint: decision.nativeLevels }
              : {}),
            ...(request.surfaceHostExecutables
              ? { surfaceHostExecutables: request.surfaceHostExecutables }
              : {}),
            deadline,
          });
          remainingSnapshotSourceMs(deadline, 'snapshot-decode-deadline');
          const acquisition = createAcquisition(request.hint, request.target, envelope, limits);
          recordRecovery(
            diagnostics,
            depthHints,
            request.target,
            requestedLevels,
            explicitDepth,
            decision,
            envelope,
          );
          return { stage: 'acquired', acquisition };
        },
        { producer: SNAPSHOT_BRIDGE_PRODUCER, transport: transport.name },
      );
    } catch (error) {
      const failure = asSnapshotSourceError(error);
      return {
        stage: 'failed',
        failure: {
          kind: failure.failureKind,
          code: failure.failureCode,
          ...(failure.details ? { details: failure.details } : {}),
        },
      } satisfies SnapshotSourceOutcome;
    }
  };

  return {
    acquire,
    close: () => {
      if (closing) return closing;
      closed = true;
      closing = transport.close();
      return closing;
    },
  };
}

function validateHint(hint: CaptureHint): void {
  if (
    (hint.projection !== 'raw' && hint.projection !== 'regular') ||
    !['full', 'surface-observation'].includes(hint.acquisitionIntent) ||
    typeof hint.interactiveOnly !== 'boolean' ||
    typeof hint.customActions !== 'boolean' ||
    !validDepth(hint.rawTraversalDepth) ||
    !validDepth(hint.regularPresentedDepth)
  ) {
    throw new AppError('INVALID_ARGS', 'Simulator snapshot source capture hint is invalid');
  }
}

/**
 * Learns the accepted native depth from the guest's request accounting and reports the whole
 * acquisition's native work, so a benchmark can pair native calls, rejections, and continuations
 * with capture latency without re-deriving them from the tree. Runs only after the delivered tree
 * validated: a response whose counters look sound but whose tree fails acquisition teaches nothing.
 */
function recordRecovery(
  diagnostics: Pick<SnapshotSourceHost, 'emitDiagnostic'>,
  depthHints: AcceptedDepthHints,
  target: SnapshotBridgeTarget,
  requestedLevels: number,
  explicitDepth: boolean,
  decision: DepthHintDecision,
  envelope: SnapshotBridgeEnvelope,
): void {
  const recovery = readSnapshotBridgeRecovery(envelope);
  const truncated = envelope.truncated === true;
  const learning = depthHints.learn(target, requestedLevels, explicitDepth, recovery);
  diagnostics.emitDiagnostic({
    level: 'debug',
    phase: 'ios_snapshot_source_recovery',
    data: {
      producer: SNAPSHOT_BRIDGE_PRODUCER,
      ...(target.targetId ? { targetId: target.targetId } : {}),
      generation: target.generation,
      requestedLevels,
      hint: decision.reason,
      ...(decision.nativeLevels !== undefined ? { hintedLevels: decision.nativeLevels } : {}),
      ...recovery,
      truncated,
      learning,
    },
  });
}

function resolveRequestedDepth(hint: CaptureHint, maximum: number): number {
  const requested = hint.rawTraversalDepth ?? maximum;
  if (requested > maximum) {
    throw new AppError('INVALID_ARGS', 'Simulator snapshot source depth exceeds its bound', {
      requested,
      maximum,
    });
  }
  return requested;
}

function validDepth(value: number | null): boolean {
  return value === null || (Number.isSafeInteger(value) && value >= 0);
}

function createAcquisition(
  hint: CaptureHint,
  target: SnapshotBridgeTarget,
  envelope: SnapshotBridgeEnvelope,
  limits: SnapshotSourceLimits,
): IosSnapshotAcquisition {
  if (envelope.automationEnabled !== true) {
    throw snapshotSourceError('unsupported', 'automation-mode-unavailable');
  }
  const tree = envelope.tree;
  const truncated = envelope.truncated;
  if (typeof truncated !== 'boolean') {
    throw snapshotSourceError('malformed-tree', 'truncated-invalid');
  }
  const decoded = decodeSnapshotBridgeTree(tree, { truncated }, limits);
  const generation = envelope.generation;
  if (typeof generation !== 'string' || !generation) {
    throw snapshotSourceError('malformed-tree', 'generation-invalid');
  }
  // A tree that ends at out-of-process content — a web view's page, or a scene-hosted extension —
  // would present the screen without it, and refs issued from it would target the host views around
  // it rather than the content.
  // The source refuses it as a screen it cannot describe, like a missing automation mode, so the
  // route serves the XCTest runner, which resolves remote elements (#2484).
  if (decoded.opaqueRemoteElements > 0) {
    throw snapshotSourceError('unsupported', 'remote-content-boundary', {
      remoteElements: decoded.opaqueRemoteElements,
    });
  }
  // A tree carrying a window that reports its subtree in the device's native space would present a
  // screen whose rects disagree about which way is down, and refs issued from under that window would
  // be performed somewhere else on it. The reader cannot report the app's interface orientation, so
  // the source refuses the screen it cannot put in one space and the route serves the runner, which
  // reads the orientation and rotates what it captured (#2612).
  if (decoded.unresolvedCoordinateSpaceWindows > 0) {
    throw snapshotSourceError('unsupported', 'window-coordinate-space-unresolved', {
      windows: decoded.unresolvedCoordinateSpaceWindows,
    });
  }
  const nodes = Object.freeze(
    decoded.nodes.map((node) => Object.freeze({ ...node, pid: target.pid })),
  );
  const residue = createAcquisitionResidue(hint, truncated, decoded.viewport);
  const lineage = Object.freeze({
    ...(target.targetId ? { targetId: target.targetId } : {}),
    generation,
  });
  const common = {
    producer: SNAPSHOT_BRIDGE_PRODUCER,
    nodes,
    truncated,
    viewport: decoded.viewport,
    keyboard: observeCompleteTreeKeyboard({
      nodes,
      viewport: decoded.viewport.kind === 'reported' ? decoded.viewport.rect : null,
      complete: !truncated,
    }),
    lineage,
    residue,
  };
  if (hint.acquisitionIntent === 'full') {
    return { ...common, intent: 'full', hint: { ...hint, acquisitionIntent: 'full' } };
  }
  return {
    ...common,
    intent: 'surface-observation',
    hint: { ...hint, acquisitionIntent: 'surface-observation' },
  };
}

function createAcquisitionResidue(
  hint: CaptureHint,
  truncated: boolean,
  viewport: IosViewportEvidence,
) {
  // With a reported viewport the bridge reader has already stamped geometric `hittable` onto every
  // node (it owns that fact and the residue), so it is not declared unavailable. Only when the
  // viewport is missing does the reader withhold `hittable` and disclose it as an unavailable fact —
  // the same "the residue owner is the fact owner" rule that keeps geometry from minting the claim.
  const hittabilityResidue =
    viewport.kind === 'reported'
      ? []
      : ([{ kind: 'unavailable-fact', fact: 'hittability' }] as const);
  return Object.freeze([
    ...hittabilityResidue,
    ...(hint.interactiveOnly
      ? ([{ kind: 'unavailable-fact', fact: 'interactive-query' }] as const)
      : []),
    ...(truncated ? ([{ kind: 'truncated' }] as const) : []),
    ...(viewport.kind === 'missing'
      ? ([{ kind: 'missing-viewport', reason: viewport.reason }] as const)
      : []),
  ]);
}
