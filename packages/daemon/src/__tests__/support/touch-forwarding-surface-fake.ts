import type { CreateDaemonCommandSurface } from '@agent-device/contracts/daemon-command-surface';
import type {
  FillCommandResult,
  InteractionTarget,
  PressCommandResult,
} from '@agent-device/contracts/interaction';
import { buildSelectorChainForNode } from '@agent-device/selectors';
import { AppError } from '@agent-device/kernel/errors';
import { centerOfRect, type Point, type SnapshotNode } from '@agent-device/kernel/snapshot';
import {
  captureAndStoreSnapshot,
  commandSurfaceWithMembers,
} from './command-surface-override-fake.ts';

type TouchResolution = {
  point: Point;
  target: InteractionTarget;
  node?: SnapshotNode;
  nodes?: SnapshotNode[];
  selectorChain?: string[];
};

export type TouchForwardingSurfaceOptions = {
  /**
   * Which node a selector expression names. The default reads `label="X"` / `label=X` and
   * `id="X"` / `id=X`; a suite that needs another selector shape states its own matcher.
   */
  matchSelector?: (nodes: SnapshotNode[], selector: string) => SnapshotNode | undefined;
};

function defaultMatchSelector(nodes: SnapshotNode[], selector: string): SnapshotNode | undefined {
  const parsed = /^(label|id)="?([^"]*)"?$/.exec(selector.trim());
  if (!parsed) return undefined;
  const [, key, value] = parsed;
  return nodes.find((node) => (key === 'id' ? node.identifier : node.label) === value);
}

function refBody(ref: string): string {
  return ref.replace(/^@/, '').replace(/~s\d+$/, '');
}

/**
 * A command surface whose touch actions do what the daemon depends on the real command family
 * to do, and no more: locate the target (a stored-tree lookup for a `@ref`, one interactive
 * capture through the config's backend for a selector), dispatch the touch through the
 * config's backend, and answer with the resolved target and the tree it was read from. Selector
 * disambiguation, hittability, the moving-target gate, and every other command-family decision
 * are out of scope: the suites that use this surface pin what the daemon does around them.
 */
export function touchForwardingCreateCommandSurface(
  options: TouchForwardingSurfaceOptions = {},
): CreateDaemonCommandSurface {
  const matchSelector = options.matchSelector ?? defaultMatchSelector;
  return commandSurfaceWithMembers((config) => {
    const locate = async (
      target: InteractionTarget,
      context: { session?: string; requestId?: string; signal?: AbortSignal },
      action: 'click' | 'fill',
    ): Promise<TouchResolution> => {
      const chainFor = (node: SnapshotNode, nodes: SnapshotNode[]) =>
        buildSelectorChainForNode(node, config.backend.platform, { action, nodes });
      if (target.kind === 'point') return { point: { x: target.x, y: target.y }, target };
      if (target.kind === 'ref') {
        const record = await config.sessions?.get(context.session ?? 'default');
        const nodes = record?.snapshot?.nodes ?? [];
        const node = nodes.find((candidate) => candidate.ref === refBody(target.ref));
        if (!node?.rect) {
          throw new AppError('COMMAND_FAILED', `Ref ${target.ref} not found`, {
            reason: 'ref_not_found',
          });
        }
        return {
          point: centerOfRect(node.rect),
          target,
          node,
          nodes,
          selectorChain: chainFor(node, nodes),
        };
      }
      const { nodes } = await captureAndStoreSnapshot(config, {
        ...context,
        interactiveOnly: true,
        includeRects: true,
      });
      const node = matchSelector(nodes, target.selector);
      if (node?.rect) {
        return {
          point: centerOfRect(node.rect),
          target,
          node,
          nodes,
          selectorChain: chainFor(node, nodes),
        };
      }
      throw new AppError('COMMAND_FAILED', `Selector did not match: ${target.selector}`, {
        reason: 'selector_not_found',
      });
    };

    const resolvedTarget = (resolution: TouchResolution) => {
      const { target, point, node, nodes, selectorChain } = resolution;
      const preAction = nodes ? { nodes } : undefined;
      if (target.kind === 'point') return { kind: 'point' as const, point, preAction };
      if (target.kind === 'ref') {
        return { kind: 'ref' as const, point, target, node, selectorChain, preAction };
      }
      return {
        kind: 'selector' as const,
        point,
        target,
        node: node as SnapshotNode,
        selectorChain: selectorChain ?? [],
        preAction,
      };
    };

    const press = async (
      target: InteractionTarget,
      pressOptions?: { session?: string; requestId?: string; signal?: AbortSignal },
    ): Promise<PressCommandResult> => {
      const context = {
        session: pressOptions?.session,
        requestId: pressOptions?.requestId,
        signal: pressOptions?.signal,
      };
      const resolution = await locate(target, context, 'click');
      const backendResult = await config.backend.tap?.(context, resolution.point);
      return { ...resolvedTarget(resolution), ...(backendResult ? { backendResult } : {}) };
    };

    const fill = async (
      target: InteractionTarget,
      text: string,
      fillOptions?: { session?: string; requestId?: string; signal?: AbortSignal },
    ): Promise<FillCommandResult> => {
      const context = {
        session: fillOptions?.session,
        requestId: fillOptions?.requestId,
        signal: fillOptions?.signal,
      };
      const resolution = await locate(target, context, 'fill');
      const backendResult = await config.backend.fill?.(context, resolution.point, text);
      return {
        ...resolvedTarget(resolution),
        text,
        ...(backendResult ? { backendResult } : {}),
      };
    };

    return { interactions: { press, click: press, fill } };
  });
}
