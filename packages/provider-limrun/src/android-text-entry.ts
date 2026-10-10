/**
 * Text entry on a Limrun Android instance. The instance's `setText` inserts at the focused
 * field's cursor and rejects empty text, so it cannot honor `fill`'s replace contract alone:
 * the injector owns the replacement — focus, select-all, delete — and hands `setText` only the
 * text that replaces the selection. Selecting through the instance's own key events keeps the
 * clear on the same input channel as the typing that follows it; a second channel racing the
 * selection (adb keyevents) could lose it. `type` keeps appending: no focus, no clear.
 */
import type { AndroidTextInjectionRequest } from '@agent-device/platform-android/mechanics';

type LimrunAndroidTextClient = {
  tap: (target: { x: number; y: number }) => Promise<unknown>;
  pressKey: (key: string, modifiers?: string[]) => Promise<unknown>;
  setText: (target: { x: number; y: number } | undefined, text: string) => Promise<unknown>;
};

export function createLimrunAndroidTextInjector(
  client: LimrunAndroidTextClient,
): (request: AndroidTextInjectionRequest) => Promise<void> {
  return async (request) => {
    if (request.action !== 'fill') {
      await client.setText(request.target, request.text);
      return;
    }
    if (request.target) {
      await client.tap(request.target);
    }
    // Select what the focused field holds, then remove it: the field is now empty and the
    // caret is the insertion point. `del` is the SDK's backspace name, the delete the issue
    // reproduction verified against the stock Latin IME.
    await client.pressKey('a', ['ctrl']);
    await client.pressKey('del');
    // The empty fill is the clear request (#2063), which the clear above just completed;
    // the SDK's setText refuses an empty text, so the clear request never sends one.
    if (request.text.length > 0) {
      await client.setText(undefined, request.text);
    }
  };
}
