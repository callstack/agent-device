import { AppError } from '@agent-device/kernel/errors';
import type { SnapshotNode } from '@agent-device/kernel/snapshot';
import type { InteractionAction } from './resolution.ts';
import { interactionVerb } from './interaction-verb.ts';

/**
 * The one construction site for "covered by another visible element" refusals, shared by
 * `resolution.ts`'s node-stage runner (ref, selector, native-ref preflight) and
 * `selector-readiness.ts`'s covered-target diagnosis probe. A leaf so both can import it without
 * either owning the other.
 */
export function buildCoveredInteractionError(params: {
  label: string;
  node: SnapshotNode;
  action: InteractionAction;
  selector?: string;
}): AppError {
  return new AppError(
    'COMMAND_FAILED',
    `${params.label} is covered by another visible element and cannot ${interactionVerb(params.action)} safely`,
    {
      hint: 'Use a different visible target, scroll it clear of the overlay, or inspect with snapshot/screenshot before retrying.',
      ...(params.selector ? { selector: params.selector } : {}),
      ref: `@${params.node.ref}`,
      interactionBlocked: params.node.interactionBlocked,
    },
  );
}
