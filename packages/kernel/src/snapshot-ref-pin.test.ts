import { expect, test } from 'vitest';
import { formatPinnedRef, REF_PIN_SEPARATOR } from '@agent-device/kernel/snapshot';

// A printed pin is text an agent pastes into a shell command. The allow-rule
// matchers that decide whether such a command runs unsandboxed parse the line
// first and refuse an unquoted word holding a shell metacharacter, because bash or
// zsh could expand it. A refused match runs the pasted ref in a sandbox that cannot
// reach the daemon, which is why the emitted form must stay a plain literal word.

/** The word class those matchers accept: letters, digits, and these few safe symbols. */
const SHELL_LITERAL_WORD_RE = /^[A-Za-z0-9._:@/,+-]+$/;

test('formatPinnedRef emits a plain shell-literal word', () => {
  const pin = formatPinnedRef('@e4', 434592);
  expect(pin).toBe('@e4-s434592');
  expect(pin).toMatch(SHELL_LITERAL_WORD_RE);
  // A leading `=` is a separate refusal of the same matcher.
  expect(pin[0]).not.toBe('=');
  // Named one by one, because each of them silently broke allow-rules before.
  for (const unsafe of ['{', '}', '*', '?', '[', ']', '\\', '~', '^', '#', '$', '`']) {
    expect(pin).not.toContain(unsafe);
  }
});

test('the pin separator itself carries no shell metacharacter', () => {
  expect(REF_PIN_SEPARATOR).toMatch(SHELL_LITERAL_WORD_RE);
});
