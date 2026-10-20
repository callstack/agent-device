/**
 * The action an interaction performs, and the passive verb a pre-dispatch refusal uses for it.
 *
 * Living below both the command surface and the daemon's dispatch seams keeps one vocabulary for
 * every guard that refuses before dispatch, so a rule shared by the acting paths and a route that
 * dispatches on its own (`find <locator> focus`) cannot name the same failure two ways.
 */
export type InteractionAction =
  | 'click'
  | 'press'
  | 'fill'
  | 'focus'
  | 'longPress'
  | 'hover'
  | 'scroll'
  | 'swipe'
  | 'pinch'
  | 'pan'
  | 'drag'
  | 'fling'
  | 'rotate'
  | 'transform'
  | 'tap';

/**
 * The passive verb a refusal uses for the action it declined, so every acting guard that refuses
 * before dispatch describes the failure in the caller's own words. Every action is named
 * explicitly and there is no `default`: a new `InteractionAction` fails to compile until it picks
 * the verb its refusal will use, instead of silently being refused as a tap.
 */
export function interactionVerb(action: InteractionAction): string {
  switch (action) {
    case 'click':
    case 'press':
    case 'tap':
      return 'be tapped';
    case 'fill':
      return 'be filled';
    case 'focus':
      return 'be focused';
    case 'longPress':
      return 'be long-pressed';
    case 'hover':
      return 'be hovered';
    case 'scroll':
      return 'be scrolled';
    case 'swipe':
      return 'be swiped';
    case 'pinch':
      return 'be pinched';
    case 'pan':
      return 'be panned';
    case 'drag':
      return 'be dragged';
    case 'fling':
      return 'be flung';
    case 'rotate':
      return 'be rotated';
    case 'transform':
      return 'be transformed';
  }
}
