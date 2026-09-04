import { AppError } from '@agent-device/kernel/errors';
import type { CaptureHint, IosSnapshotAcquisition } from '@agent-device/contracts/ios-snapshot';
import { ensureSnapshotBridgeBinary } from './cache.ts';
import { asSnapshotSourceError, snapshotSourceError } from './errors.ts';
import { SnapshotBridgeManager } from './lifecycle.ts';
import { resolveSnapshotSourceLimits } from './limits.ts';
import type { SnapshotBridgeEnvelope } from './protocol.ts';
import { decodeSnapshotBridgeTree } from './tree.ts';
import { createSnapshotSourceHost } from './host.ts';
import type {
  SnapshotSourceBridgeBinary,
  SnapshotSourceHost,
  SnapshotSourceLimits,
  SnapshotSourceOutcome,
  SnapshotSourceRequest,
  SnapshotSourceSuccess,
} from './types.ts';

const SNAPSHOT_SOURCE_PRODUCER = 'simulator-ax-bridge' as const;

export type SimulatorSnapshotSourceOptions = Readonly<{
  host?: SnapshotSourceHost;
  limits?: Partial<SnapshotSourceLimits>;
  sourceRoot?: string;
  cacheRoot?: string;
}>;

export type SimulatorSnapshotSource = Readonly<{
  prepare(
    input: Readonly<{ runtime: string; signal?: AbortSignal }>,
  ): Promise<SnapshotSourceBridgeBinary>;
  acquire(request: SnapshotSourceRequest): Promise<SnapshotSourceSuccess>;
  acquireOutcome(request: SnapshotSourceRequest): Promise<SnapshotSourceOutcome>;
  close(): Promise<void>;
}>;

export function createSimulatorSnapshotSource(
  options: SimulatorSnapshotSourceOptions = {},
): SimulatorSnapshotSource {
  const host = options.host ?? createSnapshotSourceHost();
  const manager = new SnapshotBridgeManager(host);
  const prepared = new Map<string, Promise<SnapshotSourceBridgeBinary>>();
  let closed = false;

  const prepare = async (
    input: Readonly<{ runtime: string; limits: SnapshotSourceLimits; signal?: AbortSignal }>,
  ) => {
    if (closed) throw snapshotSourceError('unsupported', 'source-closed');
    const key = `${input.runtime}\0${input.limits.maxNodes}\0${input.limits.maxTraversalDepth}`;
    let preparation = prepared.get(key);
    if (!preparation) {
      preparation = host.withDiagnosticTimer(
        'ios.snapshot-source.prepare',
        async () =>
          await ensureSnapshotBridgeBinary({
            host,
            runtime: input.runtime,
            limits: input.limits,
            signal: input.signal,
            sourceRoot: options.sourceRoot,
            cacheRoot: options.cacheRoot,
          }),
        { producer: SNAPSHOT_SOURCE_PRODUCER },
      );
      prepared.set(key, preparation);
      preparation.catch(() => {
        if (prepared.get(key) === preparation) prepared.delete(key);
      });
    }
    return await preparation;
  };

  const acquire = async (request: SnapshotSourceRequest): Promise<SnapshotSourceSuccess> => {
    if (closed) throw snapshotSourceError('unsupported', 'source-closed');
    validateRequest(request);
    const limits = resolveSnapshotSourceLimits({ ...options.limits, ...request.limits });
    const maxDepth = resolveRequestedDepth(request.hint, limits.maxTraversalDepth);
    const bridge = await prepare({
      runtime: request.target.runtime,
      limits,
      signal: request.signal,
    });
    return await host.withDiagnosticTimer(
      'ios.snapshot-source.acquire',
      async () => {
        const envelope = await manager.request({
          target: request.target,
          bridge,
          limits,
          maxDepth,
          signal: request.signal,
        });
        return {
          stage: 'acquired',
          acquisition: createAcquisition(request.hint, request.target, envelope, limits, maxDepth),
        };
      },
      { producer: SNAPSHOT_SOURCE_PRODUCER },
    );
  };

  const acquireOutcome = async (request: SnapshotSourceRequest): Promise<SnapshotSourceOutcome> => {
    try {
      return await acquire(request);
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
    prepare: async (input) =>
      await prepare({
        runtime: input.runtime,
        limits: resolveSnapshotSourceLimits(options.limits),
        signal: input.signal,
      }),
    acquire,
    acquireOutcome,
    close: async () => {
      if (closed) return;
      closed = true;
      prepared.clear();
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
  const nodes = Object.freeze(
    decoded.nodes.map((node) => Object.freeze({ ...node, pid: target.pid })),
  );
  const residue = Object.freeze([
    { kind: 'unavailable-fact', fact: 'hittability' } as const,
    ...(hint.interactiveOnly
      ? ([{ kind: 'unavailable-fact', fact: 'interactive-query' }] as const)
      : []),
    ...(truncated
      ? [truncationResidue(decoded.maxTraversalDepth, nodes.length, limits, maxDepth)]
      : []),
    ...(decoded.viewport.kind === 'missing'
      ? ([{ kind: 'missing-viewport', reason: decoded.viewport.reason }] as const)
      : []),
  ]);
  const lineage = Object.freeze({
    ...(target.targetId ? { targetId: target.targetId } : {}),
    generation: target.generation,
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
