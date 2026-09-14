import type { InteractionAction } from './resolution.ts';

/**
 * The passive verb a refusal uses for the action it declined, so every acting guard that refuses
 * before dispatch describes the failure in the caller's own words.
 */
export function interactionVerb(action: InteractionAction): string {
  switch (action) {
    case 'fill':
      return 'be filled';
    case 'focus':
      return 'be focused';
    case 'longPress':
      return 'be long-pressed';
    case 'hover':
      return 'be hovered';
    default:
      return 'be tapped';
  }
}
