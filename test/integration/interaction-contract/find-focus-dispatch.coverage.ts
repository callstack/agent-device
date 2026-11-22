import { definePathCoverage } from './coverage-manifest.ts';

export const FIND_FOCUS_DISPATCH_COVERAGE = definePathCoverage('find-focus-dispatch', {
  disambiguation:
    'find-focus-dispatch disambiguation: two matches refuse with bounded candidates unless --first narrows',
  occlusion: 'find-focus-dispatch occlusion: a covered match refuses to be focused',
  keyboardOcclusion: [
    'find-focus-dispatch keyboardOcclusion: a focus match behind the visible keyboard is refused with tap_keyboard_occludes_target',
    'find-focus-dispatch keyboardOcclusion: the same match above the keyboard band focuses',
    'find-focus-dispatch keyboardOcclusion: a producer-measured band refuses the match even when the captured tree cannot derive one',
  ],
  parentOwnedTouchPoint: [
    'find-focus-dispatch parentOwnedTouchPoint: a fully tiled match refuses before dispatch',
    'find-focus-dispatch parentOwnedTouchPoint: a child owning the center moves the focus to free parent space',
    'find-focus-dispatch parentOwnedTouchPoint: a sole nested text field takes the focus and the typed text',
    'find-focus-dispatch parentOwnedTouchPoint: a text field filling its cell takes the focus instead of refusing',
    'find-focus-dispatch parentOwnedTouchPoint: a label promoted to its row aims at the row field',
    'find-focus-dispatch parentOwnedTouchPoint: several nested text fields refuse with candidates before dispatch',
    'find-focus-dispatch parentOwnedTouchPoint: a disabled field does not count as a nested text field',
    'find-focus-dispatch parentOwnedTouchPoint: a covered nested text field refuses before dispatch',
    'find-focus-dispatch parentOwnedTouchPoint: a nested text field behind the keyboard refuses even when its parent is clear',
    'find-focus-dispatch parentOwnedTouchPoint: a named disabled field refuses instead of writing into its sibling',
    'find-focus-dispatch parentOwnedTouchPoint: a named non-hittable field stays the target over its sibling',
    'find-focus-dispatch parentOwnedTouchPoint: a match holding only a disabled field refuses',
    'find-focus-dispatch parentOwnedTouchPoint: a field nested in a field counts once',
    'find-focus-dispatch parentOwnedTouchPoint: an off-screen field neither takes the focus nor counts',
    'find-focus-dispatch parentOwnedTouchPoint: a label inside a disabled field refuses instead of writing into its sibling',
  ],
  offscreen: [
    'find-focus-dispatch offscreen: a closed-drawer match refuses with offscreen_ref before dispatch',
    'find-focus-dispatch offscreen: a live read that confirms the match on screen focuses at the live rect',
    'find-focus-dispatch offscreen: an on-screen twin still wins over an off-screen one',
    'find-focus-dispatch offscreen: a live hittability probe with duplicate matches refuses instead of rescuing',
    'find-focus-dispatch offscreen: a role-qualified find refuses without running an id/label rescue probe',
  ],
  nonHittable: [
    'find-focus-dispatch nonHittable: a non-hittable label retargets the dispatch to the hittable ancestor row',
    'find-focus-dispatch nonHittable: a target still non-hittable after promotion answers with targetHittable false and a hint',
  ],
  responseConstruction:
    'find-focus-dispatch responseConstruction: find focus returns the shared point-focus payload',
  errorTaxonomy:
    'find-focus-dispatch errorTaxonomy: an unmatched find focus fails with find locator diagnostics',
});
