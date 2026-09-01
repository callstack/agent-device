import { AppError } from '@agent-device/kernel/errors';
import type { ScrollDirection } from '@agent-device/contracts/scroll-gesture';
import type { Point, RawSnapshotNode, SnapshotNode } from '@agent-device/kernel/snapshot';

export type ScrollEdge = 'top' | 'bottom';

export type ScrollEdgeState = {
  canScroll: boolean;
  emptySnapshot: boolean;
  scope?: string;
};

export type ScrollEdgeTarget = {
  point?: Point;
  nodeIndex?: number;
};

const SCROLL_EDGE_PASS_LIMIT = 40;

export async function captureScrollEdgeState(params: {
  edge: ScrollEdge;
  target?: ScrollEdgeTarget;
  scope?: string;
  captureNodes: (scope?: string) => Promise<readonly (RawSnapshotNode | SnapshotNode)[]>;
}): Promise<ScrollEdgeState> {
  const { edge, target = {}, scope, captureNodes } = params;
  try {
    const nodes = await captureNodes(scope);
    const { analyzeScrollEdgeState } = await import('./scroll-edge-state/selection.ts');
    const state = analyzeScrollEdgeState(nodes, edge, target);
    if (scope && state.emptySnapshot) {
      return await captureScrollEdgeState({ edge, target, captureNodes });
    }
    return state;
  } catch (error) {
    throw buildScrollEdgeVerificationError(edge, scope, error);
  }
}

export async function runScrollEdgePasses<TResult>(params: {
  edge: ScrollEdge;
  captureState: (scope?: string) => Promise<ScrollEdgeState>;
  scroll: () => Promise<TResult>;
}): Promise<{ passes: number; result?: TResult }> {
  const { edge, captureState, scroll } = params;
  let state = await captureState();
  if (state.scope) {
    state = await captureState(state.scope);
  }

  let passes = 0;
  let result: TResult | undefined;
  while (state.canScroll) {
    if (passes >= SCROLL_EDGE_PASS_LIMIT) {
      throw new AppError(
        'COMMAND_FAILED',
        `scroll ${edge} reached the safety limit before the snapshot showed the edge`,
        {
          hint: 'The scoped scroll container still reports hidden content. Use a smaller manual scroll + snapshot loop to inspect the current state.',
        },
      );
    }

    result = await scroll();
    passes += 1;
    state = await captureState(state.scope);
  }

  return { passes, result };
}

export function formatScrollEdgeMessage(
  direction: ScrollDirection,
  edge: ScrollEdge | undefined,
  passes: number,
  amount: number | undefined,
  pixels: number | undefined,
): string {
  if (edge && passes === 0) {
    return `Already at ${edge}; no hidden content ${edge === 'bottom' ? 'below' : 'above'} detected`;
  }
  if (edge) return `Scrolled to ${edge} with ${passes} ${direction} passes`;
  if (pixels !== undefined) return `Scrolled ${direction} by ${pixels}px`;
  if (amount !== undefined) return `Scrolled ${direction} by ${amount}`;
  return `Scrolled ${direction}`;
}

function buildScrollEdgeVerificationError(
  edge: ScrollEdge,
  scope: string | undefined,
  cause: unknown,
): AppError {
  if (scope) {
    return new AppError(
      'COMMAND_FAILED',
      `Failed to verify scroll ${edge} state for scoped container`,
      {
        scope,
        hint: `scroll ${edge} could not verify the scoped scroll container. Run snapshot -i for the current screen and retry with a visible scroll target.`,
      },
      cause,
    );
  }
  return new AppError(
    'COMMAND_FAILED',
    `Failed to verify scroll ${edge} state`,
    {
      hint: `scroll ${edge} needs a snapshot showing hidden content ${edge === 'bottom' ? 'below' : 'above'} before it will move.`,
    },
    cause,
  );
}
