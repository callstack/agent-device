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
import type {
  Point,
  SnapshotNode,
  SnapshotPreferredBackend,
  SnapshotQualityVerdict,
  SnapshotState,
} from '@agent-device/kernel/snapshot';
import { extractReadableText } from '@agent-device/capture-kit/text-surface';
import { buildSelectorChainForNode } from '@agent-device/selectors';
import { fakeCreateCommandSurface } from './command-surface-fake.ts';
import {
  captureAndStoreSnapshot,
  type CommandSurfaceMembers,
} from './command-surface-override-fake.ts';

/**
 * A command surface that answers the touch actions the way the real command family does at the two
 * seams the daemon owns: it dispatches a resolved target through the runtime config's backend, and
 * it reads the session through the config's session store. Suites that pin what the daemon does
 * around a touch — admission, bound-operation wiring, response shaping, recording, settle capture
 * wiring — need both, because the daemon's decisions land on those seams.
 *
 * Target resolution is deliberately the smallest rule that lets a dispatch happen: a point is
 * itself, a `@ref` is the centre of the node the session's authorized frame (or latest
 * observation) names, and a selector is the first node of one fresh capture, written back as the
 * session's stored snapshot, that a `matchSelector` rule names (by default one of its `||`
 * alternatives, each a conjunction of `key=value` terms). A target that does not resolve refuses
 * with the typed `ref_not_found` / `selector_not_found` reason and `dispatched: 'no'`. Promotion,
 * occlusion, off-screen and bounds guards, label recovery, and `--verify` evidence are
 * command-family behavior and are asserted beside that code.
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

export type TouchSurfaceOptions = {
  /**
   * Which node a selector expression names. The default reads `||` alternatives of `key=value`
   * terms; a suite that needs another selector shape states its own matcher.
   */
  matchSelector?: (nodes: SnapshotNode[], selector: string) => SnapshotNode | undefined;
  /**
   * The post-action observation a `--settle` touch owes. It runs after the touch with the settle
   * parameters the daemon forwarded, the pre-action tree, and a capture taken through the config's
   * backend and stored as the session snapshot; its answer rides on the result. Without it the
   * touch answers a settled observation of its own.
   */
  observeSettle?: (params: {
    settle: SettleParams;
    baseline: SnapshotNode[] | undefined;
    /** The quality verdict of the tree the touch resolved against, when it published one. */
    baselineQuality: SnapshotQualityVerdict | undefined;
    capture: (options?: {
      signal?: AbortSignal;
      preferredBackend?: SnapshotPreferredBackend;
    }) => Promise<SnapshotState>;
  }) => Promise<SettleObservation>;
  /** Members the suite answers itself, layered over the touch actions (selector reads, gestures). */
  members?: (config: AgentDeviceRuntimeConfig) => CommandSurfaceMembers;
};

type Rules = Readonly<{
  matchSelector: NonNullable<TouchSurfaceOptions['matchSelector']>;
  observeSettle: TouchSurfaceOptions['observeSettle'];
}>;

export function createTouchCommandSurface(
  surfaceOptions: TouchSurfaceOptions = {},
): CreateDaemonCommandSurface {
  const rules: Rules = {
    matchSelector: surfaceOptions.matchSelector ?? matchesSelector,
    observeSettle: surfaceOptions.observeSettle,
  };
  return async (config) => {
    touchSurfaceConfigs.push(config);
    const inert = await fakeCreateCommandSurface(config);
    const own = surfaceOptions.members?.(config) ?? {};
    const selectors = touchSelectors(config, inert, rules);
    const interactions = touchInteractions(config, inert, rules);
    return {
      ...inert,
      signal: config.signal,
      capture: { ...inert.capture, ...own.capture },
      selectors: { ...selectors, ...own.selectors },
      interactions: { ...interactions, ...own.interactions },
    };
  };
}

export const touchCreateCommandSurface: CreateDaemonCommandSurface = createTouchCommandSurface();

function touchSelectors(
  config: AgentDeviceRuntimeConfig,
  inert: DaemonCommandSurface,
  rules: Rules,
): DaemonCommandSurface['selectors'] {
  return {
    ...inert.selectors,
    get: async (options) => {
      const resolved = await resolveTarget(
        config,
        rules,
        options.target,
        options,
        READ_CAPTURE_OPTIONS,
      );
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
        rules,
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
  rules: Rules,
): DaemonCommandSurface['interactions'] {
  const press = async (
    target: InteractionTarget,
    options: CommandOptions & { button?: unknown; [key: string]: unknown } = {},
  ) => {
    const resolved = await resolveTarget(config, rules, target, options, undefined, 'tapTarget');
    const backendResult = await dispatch(resolved, () => dispatchTap(config, resolved, options));
    return await finish(config, rules, resolved, options, { backendResult });
  };
  return {
    ...inert.interactions,
    click: press,
    press,
    gesture: async (options) => await dragOrInert(config, rules, inert, options),
    fill: async (target, text, options = {}) => {
      const resolved = await resolveTarget(config, rules, target, options, undefined, 'fillTarget');
      const backendResult = await dispatch(resolved, () =>
        dispatchFill(config, resolved, text, options),
      );
      return await finish(config, rules, resolved, options, { backendResult, text });
    },
    longPress: async (target, options = {}) => {
      const resolved = await resolveTarget(config, rules, target, options);
      const backendResult = await dispatch(resolved, () =>
        backendOperation(config.backend.longPress?.bind(config.backend))(
          context(config, options),
          requirePointOf(resolved),
          { durationMs: options.durationMs },
        ),
      );
      return await finish(config, rules, resolved, options, {
        backendResult,
        durationMs: options.durationMs,
      });
    },
    hover: async (target, options = {}) => {
      const resolved = await resolveTarget(
        config,
        rules,
        target,
        options,
        undefined,
        'hoverTarget',
      );
      const backendResult = await dispatch(resolved, () =>
        dispatchHover(config, resolved, options),
      );
      return await finish(config, rules, resolved, options, { backendResult });
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
  rules: Rules,
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
          rules,
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

/** The quality verdict of the tree each resolution was read from, when it published one. */
const resolvedTreeQuality = new WeakMap<object, SnapshotQualityVerdict | undefined>();

async function resolveTarget(
  config: AgentDeviceRuntimeConfig,
  rules: Rules,
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
    const node = tree?.nodes.find((candidate) => candidate.ref === refBody(target.ref));
    if (!tree || !node) {
      throw new AppError('COMMAND_FAILED', `Ref ${target.ref} not found`, {
        reason: 'ref_not_found',
        dispatched: 'no',
      });
    }
    return resolvedFromNode(config, target, node, tree, chainAction(nativeRefRoute));
  }
  const tree = await captureAndStoreSnapshot(config, {
    session: options.session,
    requestId: options.requestId,
    signal: options.signal,
    includeRects: true,
    ...captureOptions,
  });
  const node = rules.matchSelector(tree.nodes, target.selector);
  if (!node) {
    throw new AppError('COMMAND_FAILED', `Selector did not match: ${target.selector}`, {
      reason: 'selector_not_found',
      dispatched: 'no',
    });
  }
  const resolved = {
    kind: 'selector' as const,
    target: { kind: 'selector' as const, selector: target.selector },
    point: centerOf(node) as Point,
    node,
    selectorChain: selectorChainFor(config, node, tree.nodes, chainAction(nativeRefRoute)),
    preAction: { nodes: tree.nodes },
  };
  resolvedTreeQuality.set(resolved, tree.snapshotQuality);
  return resolved;
}

function chainAction(
  route: 'tapTarget' | 'fillTarget' | 'hoverTarget' | undefined,
): 'click' | 'fill' | undefined {
  if (route === 'tapTarget') return 'click';
  if (route === 'fillTarget') return 'fill';
  return undefined;
}

function selectorChainFor(
  config: AgentDeviceRuntimeConfig,
  node: SnapshotNode,
  nodes: SnapshotNode[],
  action: 'click' | 'fill' | undefined,
): string[] {
  return action
    ? buildSelectorChainForNode(node, config.backend.platform, { action, nodes })
    : buildSelectorChainForNode(node, config.backend.platform);
}

function resolvedFromNode(
  config: AgentDeviceRuntimeConfig,
  target: Extract<InteractionTarget, { kind: 'ref' }>,
  node: SnapshotNode,
  tree: Pick<SnapshotState, 'nodes' | 'snapshotQuality'>,
  action?: 'click' | 'fill',
): ResolvedInteractionTarget {
  const resolved = {
    kind: 'ref' as const,
    target: { kind: 'ref' as const, ref: target.ref },
    point: centerOf(node),
    node,
    selectorChain: selectorChainFor(config, node, tree.nodes, action),
    preAction: { nodes: tree.nodes },
  };
  resolvedTreeQuality.set(resolved, tree.snapshotQuality);
  return resolved;
}

function refBody(ref: string): string {
  return ref.replace(/^@/, '').replace(/~s\d+$/, '');
}

function centerOf(node: SnapshotNode): Point | undefined {
  const rect = node.rect;
  if (!rect) return undefined;
  return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
}

/** A selector chain: `||` alternatives, each a conjunction of `key=value` terms. */
function matchesSelector(nodes: SnapshotNode[], selector: string): SnapshotNode | undefined {
  return nodes.find((node) => nodeMatchesSelector(node, selector));
}

function nodeMatchesSelector(node: SnapshotNode, selector: string): boolean {
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
  rules: Rules,
  resolved: ResolvedInteractionTarget,
  options: CommandOptions,
  extra: TExtra,
) {
  const evidence = options.verify ? await verifyEvidence(config, resolved, options) : undefined;
  const settle = options.settle
    ? await settleObservation(config, rules, resolved, options, options.settle)
    : undefined;
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
  rules: Rules,
  resolved: ResolvedInteractionTarget,
  options: CommandOptions,
  settle: SettleParams,
): Promise<SettleObservation> {
  if (rules.observeSettle) {
    return await rules.observeSettle({
      settle,
      baseline: resolved.kind === 'point' ? undefined : resolved.preAction?.nodes,
      baselineQuality: resolvedTreeQuality.get(resolved),
      capture: (capture) =>
        captureAndStoreSnapshot(config, {
          session: options.session,
          requestId: options.requestId,
          signal: capture?.signal ?? options.signal,
          preferredBackend: capture?.preferredBackend,
          includeRects: true,
        }),
    });
  }
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
