/**
 * Guest trees for the Simulator AX source's keyboard fact: each case names the windows the fake
 * guest reports under its root, whether it cut the tree, and the fact the capture must publish.
 */

/** A guest node; `automationType` 19 is `Keyboard` and 20 is `Key`. */
function guestNode(
  elementType: string,
  frame: Readonly<{ X: number; Y: number; Width: number; Height: number }>,
  children: readonly Record<string, unknown>[] = [],
  automationType?: number,
): Record<string, unknown> {
  return {
    XC_kAXXCAttributeElementType: elementType,
    ...(automationType === undefined ? {} : { XC_kAXXCAttributeAutomationType: automationType }),
    XC_kAXXCAttributeFrame: frame,
    XC_kAXXCAttributeChildren: children,
  };
}

const APP_FRAME = { X: 0, Y: 0, Width: 390, Height: 844 };
const ASSISTANT_FRAME = { X: 0, Y: 509, Width: 390, Height: 44 };
// The docked key plane stops 58 pt above the viewport bottom, as on iPhone 17 Pro.
const DOCKED_KEYBOARD_WINDOW = guestNode('UIRemoteKeyboardWindow', APP_FRAME, [
  guestNode('TUISystemInputAssistantView', ASSISTANT_FRAME),
  guestNode(
    'UIKeyboardAutomatic',
    { X: 0, Y: 553, Width: 390, Height: 233 },
    [
      guestNode('UIKeyboardLayoutStar', { X: 0, Y: 553, Width: 390, Height: 233 }, [
        guestNode('UIAccessibilityElementKBKey', { X: 0, Y: 560, Width: 195, Height: 54 }, [], 20),
        guestNode(
          'UIAccessibilityElementKBKey',
          { X: 195, Y: 560, Width: 195, Height: 54 },
          [],
          20,
        ),
      ]),
    ],
    19,
  ),
]);

const notObserved = { kind: 'unmeasurable', reason: 'keyboard-not-observed' };

export const ADAPTER_KEYBOARD_CASES: readonly Readonly<{
  name: string;
  windows: readonly Record<string, unknown>[];
  truncated: boolean;
  keyboard: Record<string, unknown>;
}>[] = [
  {
    name: 'a docked keyboard',
    windows: [DOCKED_KEYBOARD_WINDOW],
    truncated: false,
    keyboard: {
      kind: 'derived',
      derivation: 'docked-tree',
      frame: { x: 0, y: 553, width: 390, height: 291 },
      treeBound: true,
    },
  },
  {
    name: 'a complete tree',
    windows: [],
    truncated: false,
    keyboard: { kind: 'absent', treeBound: true },
  },
  // A cut can drop the keyboard window, so a truncated tree proves only presence.
  { name: 'a truncated tree', windows: [], truncated: true, keyboard: notObserved },
  // The in-app placeholder can outlive the key plane during a dismissal.
  {
    name: 'a placeholder without keys',
    windows: [
      guestNode('UITextEffectsWindow', APP_FRAME, [
        guestNode('_UIRemoteKeyboardPlaceholderView', { X: 0, Y: 509, Width: 390, Height: 335 }),
      ]),
    ],
    truncated: false,
    keyboard: notObserved,
  },
  // A keyboard window that exposes no keys is not proof that the keyboard is gone.
  {
    name: 'a keyboard window without keys',
    windows: [guestNode('UIRemoteKeyboardWindow', APP_FRAME)],
    truncated: false,
    keyboard: notObserved,
  },
  {
    name: 'a keyboard window that holds only a placeholder',
    windows: [
      guestNode('UIRemoteKeyboardWindow', APP_FRAME, [
        guestNode('_UIRemoteKeyboardPlaceholderView', { X: 0, Y: 509, Width: 390, Height: 335 }),
      ]),
    ],
    truncated: false,
    keyboard: notObserved,
  },
  // A minimized or hardware keyboard leaves only its assistant bar.
  {
    name: 'an assistant bar without keys',
    windows: [
      guestNode('UIRemoteKeyboardWindow', APP_FRAME, [
        guestNode('TUISystemInputAssistantView', ASSISTANT_FRAME),
      ]),
    ],
    truncated: false,
    keyboard: notObserved,
  },
];
