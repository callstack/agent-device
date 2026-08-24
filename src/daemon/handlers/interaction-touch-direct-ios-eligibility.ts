import type { CommandFlags } from '@agent-device/contracts/command';
import type { InteractionTarget } from '@agent-device/contracts/interaction';
import {
  commandSupportsSettleObservation,
  commandSupportsVerifyEvidence,
} from '../../core/command-descriptor/registry.ts';
import {
  readSimpleIosSelectorTarget,
  type DirectIosSelectorTarget,
} from '../direct-ios-selector.ts';
import { isSessionRecording } from '../session-script-publication-capability.ts';
import type { SessionState } from '../types.ts';

/**
 * Whether a Maestro-compatible click needs the direct iOS selector route.
 * Ordinary selectors always use canonical capture and point dispatch; this
 * narrow route exists only for the explicit non-hittable fallback contract.
 */

export function readDirectIosSelectorTapTarget(params: {
  session: SessionState;
  commandLabel: string;
  target: InteractionTarget;
  flags: CommandFlags | undefined;
  tapElementSelectorAvailable: boolean;
}): DirectIosSelectorTarget | null {
  const { session, commandLabel, target, flags } = params;
  if (!params.tapElementSelectorAvailable) return null;
  if (flags?.maestro?.allowNonHittableCoordinateFallback !== true) return null;
  if (commandLabel !== 'click') return null;
  if (target.kind !== 'selector') return null;
  if (isSessionRecording(session)) return null;
  if (hasNonDefaultClickOptions(flags)) return null;
  if (commandSupportsVerifyEvidence(commandLabel) && flags?.verify === true) return null;
  if (commandSupportsSettleObservation(commandLabel) && flags?.settle === true) return null;
  return readDirectSelectorWithMaestroFallback(session, target.selector, flags);
}

function readDirectSelectorWithMaestroFallback(
  session: SessionState,
  selectorExpression: string,
  flags: CommandFlags | undefined,
): DirectIosSelectorTarget | null {
  const selector = readSimpleIosSelectorTarget({ session, selectorExpression });
  if (!selector) return null;
  return {
    ...selector,
    ...(flags?.maestro?.allowNonHittableCoordinateFallback
      ? { allowNonHittableCoordinateFallback: true }
      : {}),
    ...(flags?.maestro?.expectedTapPoint ? { expectedPoint: flags.maestro.expectedTapPoint } : {}),
  };
}

/** Click knobs the fused runner request cannot honor; any of them excludes the fast path. */
const NON_DEFAULT_CLICK_OPTION_KEYS = [
  'count',
  'intervalMs',
  'holdMs',
  'jitterPx',
  'doubleTap',
] as const satisfies readonly (keyof CommandFlags)[];

function hasNonDefaultClickOptions(flags: CommandFlags | undefined): boolean {
  if (NON_DEFAULT_CLICK_OPTION_KEYS.some((key) => flags?.[key] !== undefined)) return true;
  return flags?.clickButton !== undefined && flags.clickButton !== 'primary';
}
