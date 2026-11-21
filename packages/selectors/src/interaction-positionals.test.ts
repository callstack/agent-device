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

// `type <target> <text>` splits an optional leading target off the text, and every input that
// does not decode as target + text keeps typing as pure text, exactly as it did before the
// targeted form existed.

test('readTypeTextFromPositionals leads with a real snapshot ref and keeps lookalike words as text', () => {
  assert.deepEqual(readTypeTextFromPositionals(['@e12', 'more']), {
    target: { kind: 'ref', ref: '@e12' },
    targetPositionals: ['@e12'],
    textPositionals: ['more'],
  });
  // #4360: only real refs (`@e<digits>`) are targets; a word that merely starts with @ types.
  assert.deepEqual(readTypeTextFromPositionals(['@elena', 'hi']), {
    target: undefined,
    targetPositionals: [],
    textPositionals: ['@elena', 'hi'],
  });
});

test('readTypeTextFromPositionals keeps a ref with no text out of the text slot', () => {
  // The caller refuses this as the mistargeted `fill` it usually is, so it must not
  // silently become the text "@e12".
  const decoded = readTypeTextFromPositionals(['@e12']);
  assert.deepEqual(decoded.target, { kind: 'ref', ref: '@e12' });
  assert.deepEqual(decoded.textPositionals, []);
});

test('readTypeTextFromPositionals reads a selector target only when text follows it', () => {
  assert.deepEqual(readTypeTextFromPositionals(['text="Sign in"', 'hello']), {
    target: { kind: 'selector', selector: 'text="Sign in"' },
    targetPositionals: ['text="Sign in"'],
    textPositionals: ['hello'],
  });
  // A lone selector-shaped token was pure text before the targeted form existed, so it stays one.
  assert.deepEqual(readTypeTextFromPositionals(['text=hello']), {
    target: undefined,
    targetPositionals: [],
    textPositionals: ['text=hello'],
  });
});

test('readTypeTextFromPositionals reads a point target only when a third positional follows', () => {
  assert.deepEqual(readTypeTextFromPositionals(['100', '200', 'hello']), {
    target: { kind: 'point', x: 100, y: 200 },
    targetPositionals: ['100', '200'],
    textPositionals: ['hello'],
  });
  // `type 100 200` typed "100 200" before the targeted form existed, so it still does.
  assert.deepEqual(readTypeTextFromPositionals(['100', '200']), {
    target: undefined,
    targetPositionals: [],
    textPositionals: ['100', '200'],
  });
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
