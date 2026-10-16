import { test } from 'vitest';
import assert from 'node:assert/strict';
import { interactionVerb, type InteractionAction } from './interaction-action.ts';

// Exhaustive mapping over `InteractionAction` is the compiler's check. This pins the words
// themselves, so a refusal that starts describing a non-tap gesture as a tap — which is what the
// catch-all used to do for `drag` — is a deliberate change here, not an accident inside the map.
test('every action names itself in the refusal', () => {
  const verbs: Array<[InteractionAction, string]> = [
    ['click', 'be tapped'],
    ['press', 'be tapped'],
    ['fill', 'be filled'],
    ['focus', 'be focused'],
    ['longPress', 'be long-pressed'],
    ['hover', 'be hovered'],
    ['scroll', 'be scrolled'],
    ['swipe', 'be swiped'],
    ['pinch', 'be pinched'],
    ['pan', 'be panned'],
    ['drag', 'be dragged'],
    ['fling', 'be flung'],
    ['rotate', 'be rotated'],
    ['transform', 'be transformed'],
  ];
  for (const [action, verb] of verbs) {
    assert.equal(interactionVerb(action), verb, action);
  }
});
