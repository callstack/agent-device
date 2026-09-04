import { AppError } from '@agent-device/kernel/errors';
import type { CaptureHint, IosSnapshotAcquisition } from '@agent-device/contracts/ios-snapshot';
import { ensureSnapshotBridgeBinary } from './cache.ts';
import { createSnapshotSourceDeadline, remainingSnapshotSourceMs } from './deadline.ts';
import { asSnapshotSourceError, snapshotSourceError } from './errors.ts';
import { SnapshotBridgeManager } from './lifecycle.ts';
import { resolveSnapshotSourceLimits } from './limits.ts';
import type { SnapshotBridgeEnvelope } from './protocol.ts';
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
      return await host.withDiagnosticTimer(
        'ios.snapshot-source.acquire',
        async () => {
          const bridge = await prepare({
            runtime: request.target.runtime,
            limits,
            deadline,
          });
          const envelope = await manager.request({
            target: request.target,
            bridge,
            limits,
            maxDepth,
            deadline,
          });
          remainingSnapshotSourceMs(deadline, 'snapshot-decode-deadline');
          return {
            stage: 'acquired',
            acquisition: createAcquisition(
              request.hint,
              request.target,
              envelope,
              limits,
              maxDepth,
            ),
          };
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

function resolveRequestedDepth(hint: CaptureHint, maximum: number): number {
  const requested = hint.rawTraversalDepth ?? hint.regularPresentedDepth ?? maximum;
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
  maxDepth: number,
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
  const nodes = Object.freeze(
    decoded.nodes.map((node) => Object.freeze({ ...node, pid: target.pid })),
  );
  const residue = createAcquisitionResidue(
    hint,
    truncated,
    decoded,
    limits,
    maxDepth,
    nodes.length,
  );
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
  decoded: ReturnType<typeof decodeSnapshotBridgeTree>,
  limits: SnapshotSourceLimits,
  maxDepth: number,
  nodeCount: number,
) {
  return Object.freeze([
    { kind: 'unavailable-fact', fact: 'hittability' } as const,
    ...(hint.interactiveOnly
      ? ([{ kind: 'unavailable-fact', fact: 'interactive-query' }] as const)
      : []),
    ...(truncated
      ? [truncationResidue(decoded.maxTraversalDepth, nodeCount, limits, maxDepth)]
      : []),
    ...(decoded.viewport.kind === 'missing'
      ? ([{ kind: 'missing-viewport', reason: decoded.viewport.reason }] as const)
      : []),
  ]);
}

function truncationResidue(
  maxTraversalDepth: number,
  nodeCount: number,
  limits: SnapshotSourceLimits,
  maxDepth: number,
): { kind: 'truncated'; dimension: 'nodes' | 'depth' | 'payload'; limit?: number } {
  if (nodeCount >= limits.maxNodes) {
    return { kind: 'truncated', dimension: 'nodes', limit: limits.maxNodes };
  }
  if (maxTraversalDepth >= maxDepth) {
    return { kind: 'truncated', dimension: 'depth', limit: maxDepth };
  }
  return { kind: 'truncated', dimension: 'payload', limit: limits.maxResponseBytes };
}
