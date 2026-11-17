/**
 * The return key one platform reports for the focused field, in the vocabulary both platforms'
 * readings project into: Apple's `UITextInput.returnKeyType` wording and Android's
 * `EditorInfo.imeOptions` action bits each map onto these kinds.
 *
 * `unknown` means this read could not name the key, not that the keyboard has one: the Apple runner
 * answers it when the return key it identified carries wording this vocabulary does not map (its label
 * is still reported), or when the keyboard exposes no return key it can identify at all — a number,
 * decimal or phone pad has none, and an iPad keyboard puts numbers and hide keys where the rule reads
 * the return key. Android answers it when the
 * focused editor's `imeOptions` name no action. `none` means the platform established that the field
 * offers no action key at all (Android's `IME_ACTION_NONE`); no other platform can establish absence,
 * so only Android reports it.
 */
export const KEYBOARD_RETURN_KEYS = [
  'go',
  'search',
  'send',
  'next',
  'done',
  'previous',
  'join',
  'route',
  'continue',
  'enter',
  'none',
  'unknown',
] as const;

export type KeyboardReturnKey = (typeof KEYBOARD_RETURN_KEYS)[number];

/**
 * Closed result of the `keyboard` command, grounded in the runtime operation
 * results projected by `packages/daemon/src/execution/keyboard-runtime.ts`.
 *
 * `platform` and `action` are always present; the remaining fields appear per
 * branch (`status` carries the keyboard-state fields, and a visible one its return key; `enter`
 * and iOS `dismiss` carry a `message`). It is kept as a flat closed shape rather
 * than a five-way `platform`×`action` union because the per-branch field sets
 * overlap heavily and the underlying Android keyboard-state types live in the
 * platform layer (below the public contract). The `Record` index signature of
 * the previous hand-written mirror is dropped, and the spurious `| null`s are
 * removed (the handler never returns `null` for these).
 */
export type KeyboardCommandResult = {
  platform: 'android' | 'ios';
  action: 'status' | 'dismiss' | 'enter';
  visible?: boolean;
  wasVisible?: boolean;
  dismissed?: boolean;
  attempts?: number;
  inputType?: string;
  type?: 'text' | 'number' | 'email' | 'phone' | 'password' | 'datetime' | 'unknown';
  inputMethodPackage?: string;
  focusedPackage?: string;
  focusedResourceId?: string;
  inputOwner?: 'app' | 'ime' | 'unknown';
  /** `status` on a visible keyboard: what its return key offers. Omitted when the keyboard is not
   *  visible — a hidden keyboard has no return key to report. */
  returnKey?: KeyboardReturnKey;
  /** `status` on a visible keyboard whose platform reads the key's own wording: the label the key
   *  shows with its surrounding whitespace trimmed, which can be an app's custom or a localized
   *  string. Both producers read it from a dump or the accessibility tree, and trim it there. */
  returnKeyLabel?: string;
  message?: string;
  /** iOS `dismiss` only (#1598): which mechanism actually resigned the
   *  keyboard — 'dismissKey' (tapped the keyboard's own Hide/Dismiss/Done
   *  key). Generic background-tap dismissal is deliberately unsupported
   *  (#1606 review): no query can prove a coordinate is side-effect-free,
   *  so the runner only ever taps the keyboard's own control. Absent when
   *  the keyboard was not dismissed. */
  mechanism?: 'dismissKey';
};
