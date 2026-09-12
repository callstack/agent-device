import { AppError } from '@agent-device/kernel/errors';
import type {
  CaptureHint,
  IosSnapshotAcquisition,
  IosViewportEvidence,
} from '@agent-device/contracts/ios-snapshot';
import { ensureSnapshotBridgeBinary } from './cache.ts';
import { createSnapshotSourceDeadline, remainingSnapshotSourceMs } from './deadline.ts';
import { AcceptedDepthHints, type DepthHintDecision } from './depth-hints.ts';
import { asSnapshotSourceError, snapshotSourceError } from './errors.ts';
import { SnapshotBridgeManager } from './lifecycle.ts';
import { resolveSnapshotSourceLimits } from './limits.ts';
import { readSnapshotBridgeRecovery, type SnapshotBridgeEnvelope } from './protocol.ts';
import { decodeSnapshotBridgeTree } from './tree.ts';
import { createSnapshotSourceHost } from './host.ts';
import type {
  SnapshotSourceHost,
  SnapshotSourceBridgeBinary,
  SnapshotSourceLimits,
  SnapshotSourceOutcome,
  SnapshotSourceRequest,
} from './types.ts';

const SNAPSHOT_SOURCE_PRODUCER = 'simulator-ax-bridge' as const;

export type SimulatorSnapshotSourceOptions = Readonly<{
  host?: SnapshotSourceHost;
  limits?: Partial<SnapshotSourceLimits>;
  sourceRoot?: string;
  cacheRoot?: string;
}>;

export type SimulatorSnapshotSource = Readonly<{
  acquire(request: SnapshotSourceRequest): Promise<SnapshotSourceOutcome>;
  close(): Promise<void>;
}>;

export function createSimulatorSnapshotSource(
  options: SimulatorSnapshotSourceOptions = {},
): SimulatorSnapshotSource {
  const host = options.host ?? createSnapshotSourceHost();
  const manager = new SnapshotBridgeManager(host);
  const depthHints = new AcceptedDepthHints();
  const preparedBinaries = new Map<string, SnapshotSourceBridgeBinary>();
  let closed = false;

  const prepare = async (
    input: Readonly<{
      runtime: string;
      limits: SnapshotSourceLimits;
      deadline: import('./deadline.ts').SnapshotSourceDeadline;
    }>,
  ) => {
    if (closed) throw snapshotSourceError('unsupported', 'source-closed');
    const prepared = preparedBinaries.get(input.runtime);
    if (prepared) return prepared;
    const completed = await host.withDiagnosticTimer(
      'ios.snapshot-source.prepare',
      async () =>
        await ensureSnapshotBridgeBinary({
          host,
          runtime: input.runtime,
          limits: input.limits,
          deadline: input.deadline,
          sourceRoot: options.sourceRoot,
          cacheRoot: options.cacheRoot,
        }),
      { producer: SNAPSHOT_SOURCE_PRODUCER },
    );
    preparedBinaries.set(input.runtime, completed);
    return completed;
  };

  const acquire = async (request: SnapshotSourceRequest): Promise<SnapshotSourceOutcome> => {
    try {
      if (closed) throw snapshotSourceError('unsupported', 'source-closed');
      validateRequest(request);
      const limits = resolveSnapshotSourceLimits({ ...options.limits, ...request.limits });
      const deadline = createSnapshotSourceDeadline(limits.maxDurationMs, request.signal);
      const maxDepth = resolveRequestedDepth(request.hint, limits.maxTraversalDepth);
      const requestedLevels = maxDepth + 1;
      const explicitDepth = request.hint.rawTraversalDepth !== null;
      return await host.withDiagnosticTimer(
        'ios.snapshot-source.acquire',
        async () => {
          const bridge = await prepare({
            runtime: request.target.runtime,
            limits,
            deadline,
          });
          const decision = depthHints.consume(request.target, requestedLevels, explicitDepth);
          const envelope = await manager.request({
            target: request.target,
            bridge,
            limits,
            maxDepth,
            nativeLevelsHint: decision.nativeLevels,
            deadline,
          });
          remainingSnapshotSourceMs(deadline, 'snapshot-decode-deadline');
          const acquisition = createAcquisition(request.hint, request.target, envelope, limits);
          recordRecovery(
            host,
            depthHints,
            request.target,
            requestedLevels,
            explicitDepth,
            decision,
            envelope,
          );
          return { stage: 'acquired', acquisition };
        },
        { producer: SNAPSHOT_SOURCE_PRODUCER },
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
    close: async () => {
      if (closed) return;
      closed = true;
      await manager.close();
    },
  };
}

// fallow-ignore-next-line complexity
function validateRequest(request: SnapshotSourceRequest): void {
  if (
    !request.target.udid.trim() ||
    !request.target.runtime.trim() ||
    !request.target.generation.trim() ||
    !Number.isSafeInteger(request.target.pid) ||
    request.target.pid <= 0
  ) {
    throw new AppError('INVALID_ARGS', 'Simulator snapshot source target identity is incomplete');
  }
  const hint = request.hint;
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
  host: SnapshotSourceHost,
  depthHints: AcceptedDepthHints,
  target: SnapshotSourceRequest['target'],
  requestedLevels: number,
  explicitDepth: boolean,
  decision: DepthHintDecision,
  envelope: SnapshotBridgeEnvelope,
): void {
  const recovery = readSnapshotBridgeRecovery(envelope);
  const truncated = envelope.truncated === true;
  const learning = depthHints.learn(target, requestedLevels, explicitDepth, recovery);
  host.emitDiagnostic({
    level: 'debug',
    phase: 'ios_snapshot_source_recovery',
    data: {
      producer: SNAPSHOT_SOURCE_PRODUCER,
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
  target: SnapshotSourceRequest['target'],
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
  // A tree that ends at a web view's out-of-process page would present the screen without the
  // page, and refs issued from it would target the host views around it rather than the page.
  // The source refuses it as a screen it cannot describe, like a missing automation mode, so the
  // route serves the XCTest runner, which resolves remote elements (#2484).
  if (decoded.opaqueRemoteElements > 0) {
    throw snapshotSourceError('unsupported', 'remote-content-boundary', {
      remoteElements: decoded.opaqueRemoteElements,
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
    producer: SNAPSHOT_SOURCE_PRODUCER,
    nodes,
    truncated,
    viewport: decoded.viewport,
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
  return Object.freeze([
    { kind: 'unavailable-fact', fact: 'hittability' } as const,
    ...(hint.interactiveOnly
      ? ([{ kind: 'unavailable-fact', fact: 'interactive-query' }] as const)
      : []),
    ...(truncated ? ([{ kind: 'truncated' }] as const) : []),
    ...(viewport.kind === 'missing'
      ? ([{ kind: 'missing-viewport', reason: viewport.reason }] as const)
      : []),
  ]);
}
