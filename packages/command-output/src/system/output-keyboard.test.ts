import { expect, test } from 'vitest';
import { systemCliOutputFormatters } from './output.ts';

function keyboardText(result: Parameters<typeof systemCliOutputFormatters.keyboard>[0]['result']) {
  return systemCliOutputFormatters.keyboard({
    env: process.env,
    stderrIsTTY: false,
    input: {},
    result,
  }).text;
}

// Both platforms answer `status`, so the shared lines come first and the platform's own evidence
// follows. The return key belongs to the visible keyboard, so it is printed on iOS as much as on
// Android, before the IME fields that only Android reads.
test('keyboard status CLI output prints the return key on iOS', () => {
  expect(
    keyboardText({
      platform: 'ios',
      action: 'status',
      visible: true,
      returnKey: 'search',
      returnKeyLabel: 'Search',
    }),
  ).toBe(['Keyboard visible: yes', 'Return key: search', 'Return key label: Search'].join('\n'));
});

// The kind is the useful answer when the key carries no readable wording: a localized key the reader
// cannot name still reports its label.
test('keyboard status CLI output prints an unknown kind with the label it could read', () => {
  expect(
    keyboardText({
      platform: 'ios',
      action: 'status',
      visible: true,
      returnKey: 'unknown',
      returnKeyLabel: '\u641c\u3059',
    }),
  ).toBe(
    ['Keyboard visible: yes', 'Return key: unknown', 'Return key label: \u641c\u3059'].join('\n'),
  );
});

// The pad case: a number or phone keyboard has no return key, so the read reports the kind it proved
// and no label. Printing a label line here would tell a caller a key exists to press.
test('keyboard status CLI output prints an unknown kind with no label', () => {
  expect(
    keyboardText({ platform: 'ios', action: 'status', visible: true, returnKey: 'unknown' }),
  ).toBe(['Keyboard visible: yes', 'Return key: unknown'].join('\n'));
});

// Closest negative: a hidden keyboard has no return key, so neither line appears — the reader must
// not be told a key exists.
test('keyboard status CLI output prints no return key while the keyboard is hidden', () => {
  expect(keyboardText({ platform: 'ios', action: 'status', visible: false })).toBe(
    'Keyboard visible: no',
  );
});

test("keyboard status CLI output prints the return key among Android's IME fields", () => {
  expect(
    keyboardText({
      platform: 'android',
      action: 'status',
      visible: true,
      type: 'text',
      inputOwner: 'app',
      returnKey: 'send',
      returnKeyLabel: 'Send Message',
    }),
  ).toBe(
    [
      'Keyboard visible: yes',
      'Return key: send',
      'Return key label: Send Message',
      'Input type: text',
      'Input owner: app',
      'Next action: Keyboard is visible and focused input appears app-owned; fill/type can proceed.',
    ].join('\n'),
  );
});

// `dismiss` and `enter` still answer with their message alone: neither reports a keyboard it did not
// look at after acting, so the status lines must not leak into them.
test('keyboard dismiss CLI output stays the message alone', () => {
  expect(
    keyboardText({
      platform: 'ios',
      action: 'dismiss',
      visible: false,
      dismissed: true,
      wasVisible: true,
      message: 'Keyboard dismissed via its dismiss key',
    }),
  ).toBe('Keyboard dismissed via its dismiss key');
});
