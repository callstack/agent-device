import type {
  CreateDaemonCommandSurface,
  DaemonCommandSurface,
} from '@agent-device/contracts/daemon-command-surface';
import type {
  AgentDeviceBackend,
  BackendActionResult,
  BackendCommandContext,
  BackendSnapshotOptions,
} from '@agent-device/contracts/backend';
import type {
  InteractionEvidence,
  InteractionTarget,
  PreresolvedInteractionTarget,
  ResolvedInteractionTarget,
  SettleObservation,
  SettleParams,
} from '@agent-device/contracts/interaction';
import type { AgentDeviceRuntimeConfig } from '@agent-device/contracts/runtime-contract';
import { attachResolvedInteractionTarget } from '@agent-device/host-kit/interaction-outcome';
import {
  buildDragGesturePlan,
  singlePointerPlanEndpoints,
} from '@agent-device/contracts/gesture-plan';
import { AppError } from '@agent-device/kernel/errors';
import type { Point, SnapshotNode, SnapshotState } from '@agent-device/kernel/snapshot';
import { extractReadableText } from '@agent-device/capture-kit/text-surface';
import { buildSelectorChainForNode } from '@agent-device/selectors';
import { fakeCreateCommandSurface } from './command-surface-fake.ts';

/**
 * A command surface that answers the touch actions the way the real command family does at the two
 * seams the daemon owns: it dispatches a resolved target through the runtime config's backend, and
 * it reads the session through the config's session store. Suites that pin what the daemon does
 * around a touch — admission, bound-operation wiring, response shaping, recording, settle capture
 * wiring — need both, because the daemon's decisions land on those seams.
 *
 * Target resolution is deliberately the smallest rule that lets a dispatch happen: a point is
 * itself, a `@ref` is the centre of the node the session's authorized frame (or latest
 * observation) names, and a selector is the first node of one fresh capture that matches one of its `||` alternatives
 * (each a conjunction of `key=value` terms). Promotion, occlusion, off-screen and bounds guards, label recovery, and
 * `--verify` evidence are command-family behavior and are asserted beside that code.
 *
 * Values the fake supplies itself rather than reading from a backend: an `is` read always passes
 * (`pass: true`, `matches: 1`); selector reads (`get`, `is`) capture once with
 * `READ_CAPTURE_OPTIONS`, while a point or `@ref` read captures nothing; `--verify` evidence is a
 * placeholder digest (`fake-digest-<n>`). Daemon suites assert how the daemon passes, records and
 * discloses these values, never their content; the real predicate, capture and evidence values are
 * asserted against the real command surface in `src/commands/interaction/runtime/`.
 */

/** The runtime configs this surface was assembled with, oldest first. */
export const touchSurfaceConfigs: AgentDeviceRuntimeConfig[] = [];

export function resetTouchSurfaceFake(): void {
  touchSurfaceConfigs.length = 0;
}

type CommandOptions = Readonly<{
  session?: string;
  requestId?: string;
  signal?: AbortSignal;
  settle?: SettleParams;
  verify?: boolean;
  preresolvedTarget?: PreresolvedInteractionTarget;
}>;

export const touchCreateCommandSurface: CreateDaemonCommandSurface = async (config) => {
  touchSurfaceConfigs.push(config);
  const inert = await fakeCreateCommandSurface(config);
  return {
    ...inert,
    signal: config.signal,
    selectors: touchSelectors(config, inert),
    interactions: touchInteractions(config, inert),
  };
};

function touchSelectors(
  config: AgentDeviceRuntimeConfig,
  inert: DaemonCommandSurface,
): DaemonCommandSurface['selectors'] {
  return {
    ...inert.selectors,
    get: async (options) => {
      const resolved = await resolveTarget(config, options.target, options, READ_CAPTURE_OPTIONS);
      if (resolved.kind === 'point' || !resolved.node) {
        throw new AppError('COMMAND_FAILED', 'get target did not resolve to a node');
      }
      return {
        kind: options.property,
        target: resolved.target,
        node: resolved.node,
        selectorChain: resolved.selectorChain,
        preActionNodes: resolved.preAction?.nodes ?? [],
        ...(options.property === 'text'
          ? { text: await readNodeText(config, resolved.node, options) }
          : {}),
      } as never;
    },
    is: async (options) => {
      const resolved = await resolveTarget(
        config,
        { kind: 'selector', selector: options.selector },
        options,
        READ_CAPTURE_OPTIONS,
      );
      return {
        predicate: options.predicate,
        pass: true,
        selector: options.selector,
        matches: 1,
        selectorChain: resolved.kind === 'point' ? undefined : resolved.selectorChain,
        node: resolved.kind === 'point' ? undefined : resolved.node,
        preActionNodes: resolved.kind === 'point' ? undefined : resolved.preAction?.nodes,
      };
    },
  };
}

async function readNodeText(
  config: AgentDeviceRuntimeConfig,
  node: SnapshotNode,
  options: CommandOptions,
): Promise<string> {
  const read = await config.backend.readText?.(context(config, options), node);
  return read?.text.trim() ? read.text : extractReadableText(node);
}

function touchInteractions(
  config: AgentDeviceRuntimeConfig,
  inert: DaemonCommandSurface,
): DaemonCommandSurface['interactions'] {
  const press = async (
    target: InteractionTarget,
    options: CommandOptions & { button?: unknown; [key: string]: unknown } = {},
  ) => {
    const resolved = await resolveTarget(config, target, options, undefined, 'tapTarget');
    const backendResult = await dispatch(resolved, () => dispatchTap(config, resolved, options));
    return await finish(config, resolved, options, { backendResult });
  };
  return {
    ...inert.interactions,
    click: press,
    press,
    gesture: async (options) => await dragOrInert(config, inert, options),
    fill: async (target, text, options = {}) => {
      const resolved = await resolveTarget(config, target, options, undefined, 'fillTarget');
      const backendResult = await dispatch(resolved, () =>
        dispatchFill(config, resolved, text, options),
      );
      return await finish(config, resolved, options, { backendResult, text });
    },
    longPress: async (target, options = {}) => {
      const resolved = await resolveTarget(config, target, options);
      const backendResult = await dispatch(resolved, () =>
        backendOperation(config.backend.longPress?.bind(config.backend))(
          context(config, options),
          requirePointOf(resolved),
          { durationMs: options.durationMs },
        ),
      );
      return await finish(config, resolved, options, {
        backendResult,
        durationMs: options.durationMs,
      });
    },
    hover: async (target, options = {}) => {
      const resolved = await resolveTarget(config, target, options, undefined, 'hoverTarget');
      const backendResult = await dispatch(resolved, () =>
        dispatchHover(config, resolved, options),
      );
      return await finish(config, resolved, options, { backendResult });
    },
  };
}

/**
 * A target-authored drag resolves both endpoints like a press target, performs ONE plan through
 * the backend, and reports the endpoints and the recording side channel the daemon stores. Every
 * other gesture keeps the inert answer.
 */
async function dragOrInert(
  config: AgentDeviceRuntimeConfig,
  inert: DaemonCommandSurface,
  options: Parameters<DaemonCommandSurface['interactions']['gesture']>[0],
) {
  const gesture = options.gesture;
  if (!('intent' in gesture) || gesture.intent !== 'drag')
    return await inert.interactions.gesture(options);
  const commandOptions = { session: options.session, requestId: options.requestId };
  const [source, destination] = await Promise.all(
    [gesture.source, gesture.destination].map(
      async (expression) =>
        await resolveTarget(
          config,
          expression.startsWith('@')
            ? { kind: 'ref', ref: expression }
            : { kind: 'selector', selector: expression },
          commandOptions,
        ),
    ),
  );
  const viewport =
    (await config.backend.resolveGestureViewport?.(context(config, commandOptions))) ??
    source!.preAction?.nodes.find((node) => node.rect)?.rect;
  if (!viewport) throw new AppError('COMMAND_FAILED', 'gesture viewport is unavailable');
  const plan = buildDragGesturePlan(
    {
      from: requirePointOf(source!),
      to: requirePointOf(destination!),
      sourceHoldMs: gesture.sourceHoldMs,
      moveMs: gesture.moveMs,
      destinationHoldMs: gesture.destinationHoldMs,
    },
    viewport,
  );
  const backendResult = await backendOperation(config.backend.performGesture?.bind(config.backend))(
    context(config, commandOptions),
    plan,
  );
  const { start: from, end: to } = singlePointerPlanEndpoints(plan);
  const durationMs = plan.durationMs;
  const endpoint = (resolved: ResolvedInteractionTarget) => {
    if (resolved.kind === 'point' || !resolved.node || !resolved.selectorChain) {
      throw new AppError('COMMAND_FAILED', 'drag endpoint did not resolve to a node');
    }
    return {
      selectorChain: resolved.selectorChain,
      node: resolved.node,
      preActionNodes: resolved.preAction?.nodes ?? [],
    };
  };
  const sourceTarget = endpoint(source!);
  const destinationTarget = endpoint(destination!);
  const exact = { source: 'ref', phase: 'pre-action', kind: 'exact' } as const;
  return {
    kind: 'drag',
    durationMs,
    pointerCount: 1,
    from,
    to,
    backendResult: backendResult ?? undefined,
    targets: {
      source: { selectorChain: sourceTarget.selectorChain, resolution: exact },
      destination: { selectorChain: destinationTarget.selectorChain, resolution: exact },
    },
    recording: {
      sourceSelector: sourceTarget.selectorChain.join(' || '),
      destinationSelector: destinationTarget.selectorChain.join(' || '),
      sourceTarget,
      destinationTarget,
    },
  } as const;
}

/** What a read (`get`, `is`) asks its capture for: the whole tree, with rects. */
const READ_CAPTURE_OPTIONS = { interactiveOnly: false, includeRects: true } as const;

async function resolveTarget(
  config: AgentDeviceRuntimeConfig,
  target: InteractionTarget,
  options: CommandOptions,
  captureOptions: BackendSnapshotOptions = { interactiveOnly: true },
  nativeRefRoute?: 'tapTarget' | 'fillTarget' | 'hoverTarget',
): Promise<ResolvedInteractionTarget> {
  if (target.kind === 'point') return { kind: 'point', point: { x: target.x, y: target.y } };
  const pre = options.preresolvedTarget;
  if (pre && target.kind === 'ref') return resolvedFromNode(config, target, pre.node, pre.tree);
  if (target.kind === 'ref') {
    if (nativeRefRoute && config.backend[nativeRefRoute]) return { kind: 'ref', target };
    const record = await config.sessions?.get(options.session ?? 'default');
    const tree = record?.refFrameSnapshot ?? record?.snapshot;
    const node = tree?.nodes.find((candidate) => `@${candidate.ref}` === refBody(target.ref));
    if (!tree || !node) throw new AppError('COMMAND_FAILED', `Ref ${target.ref} not found`);
    return resolvedFromNode(config, target, node, tree);
  }
  const captured = await config.backend.captureSnapshot?.(context(config, options), captureOptions);
  const tree = captured?.snapshot;
  const node = tree?.nodes.find((candidate) => matchesSelector(candidate, target.selector));
  if (!tree || !node) {
    throw new AppError('COMMAND_FAILED', `Selector ${target.selector} did not match`);
  }
  return {
    kind: 'selector',
    target: { kind: 'selector', selector: target.selector },
    point: centerOf(node) as Point,
    node,
    selectorChain: buildSelectorChainForNode(node, config.backend.platform),
    preAction: { nodes: tree.nodes },
  };
}

function resolvedFromNode(
  config: AgentDeviceRuntimeConfig,
  target: Extract<InteractionTarget, { kind: 'ref' }>,
  node: SnapshotNode,
  tree: Pick<SnapshotState, 'nodes'>,
): ResolvedInteractionTarget {
  return {
    kind: 'ref',
    target: { kind: 'ref', ref: target.ref },
    point: centerOf(node),
    node,
    selectorChain: buildSelectorChainForNode(node, config.backend.platform),
    preAction: { nodes: tree.nodes },
  };
}

function refBody(ref: string): string {
  return ref.startsWith('@') ? ref : `@${ref}`;
}

function centerOf(node: SnapshotNode): Point | undefined {
  const rect = node.rect;
  if (!rect) return undefined;
  return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
}

/** A selector chain: `||` alternatives, each a conjunction of `key=value` terms. */
function matchesSelector(node: SnapshotNode, selector: string): boolean {
  const actual: Record<string, string | undefined> = {
    id: node.identifier,
    label: node.label,
    text: node.label ?? node.value,
    value: node.value,
    role: node.type?.replace(/^XCUIElementType/i, '').toLowerCase(),
  };
  return selector.split(' || ').some((alternative) => {
    const terms = [...alternative.matchAll(/(\w+)=(?:"((?:[^"\\]|\\.)*)"|(\S+))/g)];
    return (
      terms.length > 0 && terms.every(([, key, quoted, bare]) => actual[key!] === (quoted ?? bare))
    );
  });
}

function context(config: AgentDeviceRuntimeConfig, options: CommandOptions): BackendCommandContext {
  return {
    session: options.session,
    requestId: options.requestId,
    signal: options.signal ?? config.signal,
  };
}

async function dispatch(
  resolved: ResolvedInteractionTarget,
  run: () => Promise<BackendActionResult>,
): Promise<BackendActionResult> {
  try {
    return await run();
  } catch (error) {
    attachResolvedInteractionTarget(error, resolved);
    throw error;
  }
}

function backendOperation<TOperation>(operation: TOperation | undefined): TOperation {
  if (!operation) {
    throw new AppError('UNSUPPORTED_OPERATION', 'backend does not support the action');
  }
  return operation;
}

function requirePointOf(resolved: ResolvedInteractionTarget): Point {
  if (resolved.kind === 'point') return resolved.point;
  if (!resolved.point) throw new AppError('COMMAND_FAILED', 'resolved target has no point');
  return resolved.point;
}

async function dispatchTap(
  config: AgentDeviceRuntimeConfig,
  resolved: ResolvedInteractionTarget,
  options: CommandOptions & { button?: unknown },
): Promise<BackendActionResult> {
  const tapOptions = options as Parameters<NonNullable<AgentDeviceBackend['tap']>>[2];
  if (resolved.kind === 'ref' && !resolved.point && config.backend.tapTarget) {
    return await config.backend.tapTarget(context(config, options), resolved.target, tapOptions);
  }
  return await backendOperation(config.backend.tap?.bind(config.backend))(
    context(config, options),
    requirePointOf(resolved),
    tapOptions,
  );
}

async function dispatchFill(
  config: AgentDeviceRuntimeConfig,
  resolved: ResolvedInteractionTarget,
  text: string,
  options: CommandOptions & { delayMs?: number },
): Promise<BackendActionResult> {
  const fillOptions = {
    delayMs: options.delayMs,
    allowNonHittableCoordinateFallback: (
      options as { allowNonHittableCoordinateFallback?: boolean }
    ).allowNonHittableCoordinateFallback,
  };
  if (resolved.kind === 'ref' && !resolved.point && config.backend.fillTarget) {
    return await config.backend.fillTarget(
      context(config, options),
      resolved.target,
      text,
      fillOptions,
    );
  }
  return await backendOperation(config.backend.fill?.bind(config.backend))(
    context(config, options),
    requirePointOf(resolved),
    text,
    fillOptions,
  );
}

async function dispatchHover(
  config: AgentDeviceRuntimeConfig,
  resolved: ResolvedInteractionTarget,
  options: CommandOptions,
): Promise<BackendActionResult> {
  if (resolved.kind === 'ref' && !resolved.point && config.backend.hoverTarget) {
    return await config.backend.hoverTarget(context(config, options), resolved.target);
  }
  return await backendOperation(config.backend.hover?.bind(config.backend))(
    context(config, options),
    requirePointOf(resolved),
  );
}

async function finish<TExtra extends Record<string, unknown>>(
  config: AgentDeviceRuntimeConfig,
  resolved: ResolvedInteractionTarget,
  options: CommandOptions,
  extra: TExtra,
) {
  const evidence = options.verify ? await verifyEvidence(config, resolved, options) : undefined;
  const settle = options.settle ? await settleObservation(config, resolved, options) : undefined;
  return {
    ...resolved,
    ...extra,
    ...(evidence ? { evidence } : {}),
    ...(settle ? { settle } : {}),
  } as never;
}

async function verifyEvidence(
  config: AgentDeviceRuntimeConfig,
  resolved: ResolvedInteractionTarget,
  options: CommandOptions,
): Promise<InteractionEvidence> {
  const after = await config.backend.captureSnapshot?.(context(config, options), {
    interactiveOnly: true,
  });
  const nodes = after?.snapshot?.nodes ?? [];
  const before = resolved.kind === 'point' ? undefined : resolved.preAction?.nodes;
  return {
    nodeCount: nodes.length,
    interactiveNodeCount: nodes.length,
    digest: `fake-digest-${nodes.length}`,
    changedFromBefore: before === undefined || before.length !== nodes.length,
  };
}

async function settleObservation(
  config: AgentDeviceRuntimeConfig,
  resolved: ResolvedInteractionTarget,
  options: CommandOptions,
): Promise<SettleObservation> {
  const captures = resolved.kind === 'point' ? 2 : 1;
  for (let capture = 0; capture < captures; capture += 1) {
    await config.backend.captureSnapshot?.(context(config, options), { interactiveOnly: true });
  }
  return {
    settled: true,
    waitedMs: 0,
    captures,
    quietMs: options.settle?.quietMs ?? 0,
    timeoutMs: options.settle?.timeoutMs ?? 0,
  };
}
