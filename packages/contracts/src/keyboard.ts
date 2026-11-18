/** A platform reports `unknown` when it cannot identify the action and `none` when it establishes there is no action. */
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
  /** The dismiss mechanism when the serving runtime reports one. */
  mechanism?: 'dismissKey';
};
