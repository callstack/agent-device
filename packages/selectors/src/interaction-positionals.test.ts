import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  readFillTargetFromPositionals,
  readInteractionTargetFromPositionals,
  readTypeTextFromPositionals,
} from './interaction-positionals.ts';

function assertInvalidArgs(fn: () => unknown, messageFragment: string) {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { code?: unknown }).code, 'INVALID_ARGS');
    assert.ok(
      error.message.includes(messageFragment),
      `expected error message to include ${JSON.stringify(messageFragment)}, got ${JSON.stringify(error.message)}`,
    );
    return true;
  });
}

test('readInteractionTargetFromPositionals points a role word used as a key at role=/label=', () => {
  assertInvalidArgs(
    () => readInteractionTargetFromPositionals(['button="Push Article"']),
    'Unknown selector key "button". Supported:',
  );
  assertInvalidArgs(
    () => readInteractionTargetFromPositionals(['button="Push Article"']),
    'Did you mean role=button label="Push Article"?',
  );
});

test('readInteractionTargetFromPositionals folds unquoted multi-word values into the suggestion', () => {
  // An unquoted value splits across positionals; the hint must keep the full text, not just
  // the fragment attached to the key.
  assertInvalidArgs(
    () => readInteractionTargetFromPositionals(['button=Push', 'Article']),
    'Did you mean role=button label="Push Article"?',
  );
});

test('readInteractionTargetFromPositionals points an unknown non-role key at label=', () => {
  assertInvalidArgs(
    () => readInteractionTargetFromPositionals(['color="red"']),
    'Unknown selector key "color". Supported:',
  );
  assertInvalidArgs(
    () => readInteractionTargetFromPositionals(['color="red"']),
    'Did you mean label="red"?',
  );
  // Non-role keys never get the role= suggestion.
  assert.throws(
    () => readInteractionTargetFromPositionals(['color="red"']),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(!error.message.includes('role='));
      return true;
    },
  );
});

test('readInteractionTargetFromPositionals keeps existing behavior for a known key with a bad value', () => {
  assertInvalidArgs(
    () => readInteractionTargetFromPositionals(['visible=maybe']),
    'is not a @ref, selector, or "x y" point',
  );
});

test('readInteractionTargetFromPositionals still parses "x y" points', () => {
  assert.deepEqual(readInteractionTargetFromPositionals(['10', '20']), { x: 10, y: 20 });
});

test('readInteractionTargetFromPositionals still resolves @refs and valid selectors', () => {
  assert.deepEqual(readInteractionTargetFromPositionals(['@e5']), { ref: '@e5' });
  assert.deepEqual(readInteractionTargetFromPositionals(['text="Sign in"']), {
    selector: 'text="Sign in"',
  });
});

test('readFillTargetFromPositionals points a role word used as a key at role=/label= too', () => {
  assertInvalidArgs(
    () => readFillTargetFromPositionals(['button="Push Article"', 'hello']),
    'Did you mean role=button label="Push Article"?',
  );
  // Fill treats the first two positionals as the target; an unquoted split value folds back in.
  assertInvalidArgs(
    () => readFillTargetFromPositionals(['button=Push', 'Article', 'hello']),
    'Did you mean role=button label="Push Article"?',
  );
});

test('readFillTargetFromPositionals still parses "x y" points and selectors', () => {
  assert.deepEqual(readFillTargetFromPositionals(['10', '20', 'hi']), {
    kind: 'point',
    target: { x: 10, y: 20 },
    text: 'hi',
  });
  assert.deepEqual(readFillTargetFromPositionals(['id="field-email"', 'qa@example.com']), {
    kind: 'selector',
    target: { selector: 'id="field-email"' },
    text: 'qa@example.com',
  });
});

test('readFillTargetFromPositionals treats every token after a ref as text', () => {
  assert.deepEqual(readFillTargetFromPositionals(['@e29~s317228', 'good', 'morning']), {
    kind: 'ref',
    target: { ref: '@e29~s317228' },
    text: 'good morning',
  });
});

// `type <target> <text>` splits an optional leading target off the text, and the target is only
// a leading minted snapshot ref. Every positional base typed as text stays text, so unquoted
// multi-word calls keep typing whole (#4870 review).

test('readTypeTextFromPositionals leads with a minted snapshot ref and keeps lookalike words as text', () => {
  assert.deepEqual(readTypeTextFromPositionals(['@e12', 'more']), {
    target: { kind: 'ref', ref: '@e12' },
    targetPositionals: ['@e12'],
    textPositionals: ['more'],
  });
  // The pin suffix is part of the minted ref, so a pinned ref still leads a target.
  assert.deepEqual(readTypeTextFromPositionals(['@e29~s317228', 'good', 'morning']), {
    target: { kind: 'ref', ref: '@e29~s317228' },
    targetPositionals: ['@e29~s317228'],
    textPositionals: ['good', 'morning'],
  });
  // #4360: only real refs (`@e<digits>`, optional `~s<digits>`) are targets; a word that merely
  // starts with @ types, whatever follows it.
  for (const lookalike of ['@elena', '@E5', '@e2e', '@e12~sX', '@e12~s3x']) {
    assert.deepEqual(
      readTypeTextFromPositionals([lookalike, 'hi']),
      { target: undefined, targetPositionals: [], textPositionals: [lookalike, 'hi'] },
      lookalike,
    );
  }
});

test('readTypeTextFromPositionals keeps a ref with no text out of the text slot', () => {
  // The caller refuses this as the mistargeted `fill` it usually is, so it must not
  // silently become the text "@e12".
  const decoded = readTypeTextFromPositionals(['@e12']);
  assert.deepEqual(decoded.target, { kind: 'ref', ref: '@e12' });
  assert.deepEqual(decoded.textPositionals, []);
});

test('readTypeTextFromPositionals never decodes base text as a selector or point target', () => {
  // Each of these typed literally on base, so each must stay whole text that never taps
  // (#4870 review). A selector key, a bare boolean key, and a phone-number number pair are the
  // shapes the wider target vocabulary would have swallowed.
  for (const positionals of [
    ['text="Sign in"', 'hello'],
    ['text=hello'],
    ['selected', 'items', 'here'],
    ['visible', 'soon'],
    ['555', '123', '4567'],
    ['1', '2', '3'],
    ['100', '200'],
    ['label="Deploy"', 'hi'],
    // A ref quoted together with its text is one positional with a space, so it is not a
    // leading minted ref and types whole, exactly as base did.
    ['@e12 more'],
  ] as const) {
    assert.deepEqual(
      readTypeTextFromPositionals([...positionals]),
      { target: undefined, targetPositionals: [], textPositionals: [...positionals] },
      positionals.join(' '),
    );
  }
});

test('readTypeTextFromPositionals keeps plain words as pure text', () => {
  assert.deepEqual(readTypeTextFromPositionals(['hello', 'world']), {
    target: undefined,
    targetPositionals: [],
    textPositionals: ['hello', 'world'],
  });
  assert.deepEqual(readTypeTextFromPositionals(['text', 'hello']), {
    target: undefined,
    targetPositionals: [],
    textPositionals: ['text', 'hello'],
  });
});
