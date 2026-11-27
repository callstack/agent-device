import assert from 'node:assert/strict';
import { test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import {
  readFillTargetFromPositionals,
  readInteractionTargetFromPositionals,
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

test('readFillTargetFromPositionals points an unknown key at role=/label= without quoting positionals', () => {
  assertInvalidArgs(
    () => readFillTargetFromPositionals(['button="Push Article"', 'pw-secret']),
    'Did you mean role=<role> label="..."?',
  );
  assertInvalidArgs(
    () => readFillTargetFromPositionals(['button=Push', 'Article', 'pw-secret']),
    'Did you mean role=<role> label="..."?',
  );
  assertInvalidArgs(
    () => readFillTargetFromPositionals(['color="red"', 'pw-secret']),
    'Did you mean label="..."?',
  );
  assert.throws(
    () => readFillTargetFromPositionals(['color="red"', 'pw-secret']),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(!error.message.includes('role='));
      return true;
    },
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
  assert.deepEqual(readFillTargetFromPositionals(['@e29-s317228', 'good', 'morning']), {
    kind: 'ref',
    target: { ref: '@e29-s317228' },
    text: 'good morning',
  });
});

function refusalReason(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof AppError);
    assert.equal(error.code, 'INVALID_ARGS');
    return error.details?.reason;
  }
  assert.fail('expected an INVALID_ARGS refusal');
}

test('readFillTargetFromPositionals refuses a fill that received only its text', () => {
  // fill $REF "136849" with an unset REF, and fill "$REF" "136849" with an unset REF.
  for (const positionals of [['136849'], ['', '136849']]) {
    assert.equal(
      refusalReason(() => readFillTargetFromPositionals(positionals)),
      'fill_target_missing',
      JSON.stringify(positionals),
    );
  }
});

test('readFillTargetFromPositionals keeps the target diagnostics that are not a missing target', () => {
  for (const positionals of [
    [''],
    ['button="Submit"'],
    ['label=Sign in'],
    ['role=button label=Sign in'],
    ['label="Sign in'],
    ['Email', 'qa@example.com'],
  ]) {
    assert.equal(
      refusalReason(() => readFillTargetFromPositionals(positionals)),
      undefined,
      JSON.stringify(positionals),
    );
  }
  assertInvalidArgs(
    () => readFillTargetFromPositionals(['label=Sign in']),
    'Selector values with spaces need quotes',
  );
});

test('readFillTargetFromPositionals quotes no positional in any refusal', () => {
  for (const [positionals, reason, expectedFragment] of [
    [['pw-secret'], 'fill_target_missing', 'got one value'],
    [['', 'pw-secret'], 'fill_target_missing', 'got an empty target'],
    [['e5', 'pw-secret'], undefined, 'Snapshot refs need the @ prefix'],
    [['button="Push Article"', 'pw-secret'], undefined, 'Unknown selector key'],
    [['button=Email', 'pw-secret'], undefined, 'Unknown selector key'],
    [['foo=pw-secret'], undefined, 'Unknown selector key'],
    [['Email', 'pw-secret'], undefined, 'Target is not a @ref, selector, or "x y" point'],
    [['10', 'not-y', 'pw-secret'], undefined, 'Target is not a @ref, selector, or "x y" point'],
    [['label=pw secret', 'more-secret'], undefined, 'Selector values with spaces need quotes'],
    [[''], undefined, 'Missing target'],
  ] as const) {
    let caught: unknown;
    try {
      readFillTargetFromPositionals([...positionals]);
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof AppError, JSON.stringify(positionals));
    assert.equal(caught.code, 'INVALID_ARGS', JSON.stringify(positionals));
    assert.equal(caught.details?.reason, reason, JSON.stringify(positionals));
    assert.ok(
      caught.message.includes(expectedFragment),
      `expected ${JSON.stringify(caught.message)} to include ${JSON.stringify(expectedFragment)}`,
    );
    const serialized = JSON.stringify({ message: caught.message, details: caught.details });
    assert.doesNotMatch(
      serialized,
      /pw-secret|pw secret|more-secret|Push Article|Email|not-y|\be5\b|\bfoo\b|\bbutton\b/,
      JSON.stringify(positionals),
    );
  }
});
