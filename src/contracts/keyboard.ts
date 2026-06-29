/**
 * Closed result of the `keyboard` command, grounded in the dispatch handlers'
 * literal returns (src/core/dispatch.ts `handleAndroidKeyboardCommand` /
 * `handleIosKeyboardCommand`).
 *
 * `platform` and `action` are always present; the remaining fields appear per
 * branch (Android `status`/`dismiss` carry the keyboard-state fields; `enter`
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
  message?: string;
};
