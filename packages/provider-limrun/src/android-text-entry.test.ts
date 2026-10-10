import { expect, test, vi } from 'vitest';
import type { AndroidTextInjectionRequest } from '@agent-device/platform-android/mechanics';
import { createLimrunAndroidTextInjector } from './android-text-entry.ts';

type ClientCall = 'tap' | 'pressKey:a+ctrl' | 'pressKey:del' | `setText:${string}`;

function sessionWithClient() {
  const calls: ClientCall[] = [];
  const client = {
    tap: vi.fn(async (target: { x: number; y: number }) => {
      calls.push('tap');
      return target;
    }),
    pressKey: vi.fn(async (key: string, modifiers?: string[]) => {
      calls.push(
        `pressKey:${key}${modifiers?.length ? `+${modifiers.join('+')}` : ''}` as ClientCall,
      );
    }),
    setText: vi.fn(async (_target: { x: number; y: number } | undefined, text: string) => {
      calls.push(`setText:${text}`);
      return { textLength: text.length };
    }),
  };
  return { injector: createLimrunAndroidTextInjector(client), client, calls };
}

function fillRequest(
  overrides: Partial<AndroidTextInjectionRequest> = {},
): AndroidTextInjectionRequest {
  return { action: 'fill', target: { x: 540, y: 220 }, text: 'jane@example.com', ...overrides };
}

// The instance's setText inserts at the focused field's cursor, so a fill that only calls
// setText concatenates over the old value (#3358). The injector must clear through the
// instance's own input channel before the text goes in.
test('a fill focuses the target, clears the selection, and only then sets the text', async () => {
  const { injector, client, calls } = sessionWithClient();

  await injector(fillRequest());

  expect(calls).toEqual(['tap', 'pressKey:a+ctrl', 'pressKey:del', 'setText:jane@example.com']);
  expect(client.tap).toHaveBeenCalledWith({ x: 540, y: 220 });
  // The text follows the selection the injector just established, so it goes to the field the
  // injector tapped, not to whatever the instance would re-resolve from the coordinates.
  expect(client.setText).toHaveBeenCalledWith(undefined, 'jane@example.com');
});

// `fill ""` is the clear request (#2063), and the instance rejects an empty setText ("text is
// required"), so the clear stands on its own and no text is sent.
test('an empty fill clears the field without asking setText to set empty text', async () => {
  const { injector, client, calls } = sessionWithClient();

  await injector(fillRequest({ text: '' }));

  expect(calls).toEqual(['tap', 'pressKey:a+ctrl', 'pressKey:del']);
  expect(client.setText).not.toHaveBeenCalled();
});

// `type` appends by contract: neither the focus tap nor the clear may ride that action.
test('a type sends text to the target with no tap and no clear', async () => {
  const { injector, client, calls } = sessionWithClient();

  await injector({ action: 'type', text: 'appended' });

  expect(calls).toEqual(['setText:appended']);
  expect(client.setText).toHaveBeenCalledWith(undefined, 'appended');
  expect(client.tap).not.toHaveBeenCalled();
  expect(client.pressKey).not.toHaveBeenCalled();
});

test('a fill without coordinates still clears the focused field before typing', async () => {
  const { injector, client, calls } = sessionWithClient();

  await injector(fillRequest({ target: undefined }));

  expect(calls).toEqual(['pressKey:a+ctrl', 'pressKey:del', 'setText:jane@example.com']);
  expect(client.tap).not.toHaveBeenCalled();
});
