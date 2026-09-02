import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import {
  IS_PREDICATES,
  checkIsArgs,
  checkIsPredicate,
  IS_PREDICATE_USAGE_HINT,
} from '@agent-device/selectors';
import { interactionCommandMetadata } from '../commands/interaction/metadata.ts';
import { readInputFromCli } from '../commands/cli-grammar.ts';
import type { CliFlags } from '@agent-device/contracts/command';

// Parity gate for the `is` argument contract across every surface that admits one.
//
// Three surfaces validate the same rule: the daemon handler (via `checkIsArgs`), the CLI
// grammar (`readInputFromCli`), and the runtime command that receives already-parsed
// options (`isCommand`, covered on its own production route in
// commands/interaction/runtime/selector-is.test.ts). They used to state the rule three
// times, and all three had drifted: one inlined its own predicate list, one compared the raw
// token so it rejected input the daemon accepts, and one dropped the usage hint.
//
// Sharing the rule fixed that; this pins it. A surface that stops going through admission —
// or goes through it and then discards the normalized value — breaks here, which is what a
// helper-only test could not catch.

const BASE_FLAGS = {} as CliFlags;
const EXPECTED_IS_PREDICATES = [
  'visible',
  'hidden',
  'exists',
  'absent',
  'editable',
  'selected',
  'focused',
  'text',
] as const;

type Verdict = { ok: true; predicate: string } | { ok: false; message: string; hint?: string };

function daemonVerdict(positionals: readonly string[]): Verdict {
  const checked = checkIsArgs(positionals);
  return checked.ok
    ? { ok: true, predicate: checked.predicate }
    : { ok: false, message: checked.message, ...(checked.hint ? { hint: checked.hint } : {}) };
}

function cliVerdict(positionals: string[]): Verdict {
  try {
    const input = readInputFromCli('is', positionals, BASE_FLAGS) as { predicate: string };
    return { ok: true, predicate: input.predicate };
  } catch (error) {
    assert.ok(error instanceof AppError, `expected an AppError, got ${String(error)}`);
    const hint = error.details?.hint;
    return {
      ok: false,
      message: error.message,
      ...(typeof hint === 'string' ? { hint } : {}),
    };
  }
}

// Each case is a positional list plus what both surfaces must conclude.
const CASES: readonly {
  name: string;
  positionals: string[];
  expect: 'accept' | 'refuse';
  predicate?: string;
}[] = [
  {
    name: 'predicate first',
    positionals: ['visible', 'id="ok"'],
    expect: 'accept',
    predicate: 'visible',
  },
  {
    name: 'text with an expected value',
    positionals: ['text', 'id="field"', 'Hello'],
    expect: 'accept',
    predicate: 'text',
  },
  // The daemon lower-cases before admitting, so the CLI must too or it refuses input the
  // executor would have run.
  {
    name: 'upper-case predicate',
    positionals: ['VISIBLE', 'id="ok"'],
    expect: 'accept',
    predicate: 'visible',
  },
  {
    name: 'mixed-case predicate',
    positionals: ['Text', 'id="f"', 'Hi'],
    expect: 'accept',
    predicate: 'text',
  },
  {
    name: 'absence predicate first',
    positionals: ['absent', 'id="gone"'],
    expect: 'accept',
    predicate: 'absent',
  },
  {
    name: 'absence predicate after selector',
    positionals: ['id="gone"', 'absent'],
    expect: 'accept',
    predicate: 'absent',
  },
  { name: 'unknown predicate', positionals: ['shiny', 'id="ok"'], expect: 'refuse' },
  { name: 'no predicate at all', positionals: [], expect: 'refuse' },
];

test('every is surface reaches the same verdict for the same arguments', () => {
  for (const testCase of CASES) {
    const daemon = daemonVerdict(testCase.positionals);
    const cli = cliVerdict(testCase.positionals);

    assert.equal(
      daemon.ok,
      testCase.expect === 'accept',
      `${testCase.name}: daemon should ${testCase.expect}`,
    );
    assert.equal(cli.ok, daemon.ok, `${testCase.name}: surfaces disagree on accept-vs-refuse`);

    if (daemon.ok && cli.ok) {
      assert.equal(daemon.predicate, testCase.predicate, `${testCase.name}: daemon predicate`);
      // Both surfaces must hand the NORMALIZED predicate downstream. Returning the raw token
      // is the bug this file exists for: evaluation switches on lower-case values.
      assert.equal(cli.predicate, testCase.predicate, `${testCase.name}: cli predicate`);
    }
  }
});

test('an unsupported predicate is refused with the same message and hint everywhere', () => {
  const admitted = checkIsPredicate('shiny');
  assert.equal(admitted.ok, false);
  if (admitted.ok) return;

  const daemon = daemonVerdict(['shiny', 'id="ok"']);
  const cli = cliVerdict(['shiny', 'id="ok"']);
  assert.equal(daemon.ok, false);
  assert.equal(cli.ok, false);
  if (daemon.ok || cli.ok) return;

  assert.equal(daemon.message, admitted.message);
  assert.equal(cli.message, admitted.message);
  // ADR 0010: a shared failure mode carries the shared hint on every surface, not just the
  // one whose author remembered it.
  assert.equal(daemon.hint, IS_PREDICATE_USAGE_HINT);
  assert.equal(cli.hint, IS_PREDICATE_USAGE_HINT);
});

test('command docs list every is predicate', () => {
  const docs = fs.readFileSync(
    path.resolve(import.meta.dirname, '../..', 'website/docs/docs/commands.md'),
    'utf8',
  );
  const predicateList = docs.match(/Supported predicates are ([^.]+)\./)?.[1] ?? '';
  assert.deepEqual(IS_PREDICATES, EXPECTED_IS_PREDICATES);
  for (const predicate of EXPECTED_IS_PREDICATES) {
    assert.match(predicateList, new RegExp(`\\b${predicate}\\b`));
  }

  const metadata = interactionCommandMetadata.find((entry) => entry.name === 'is');
  const predicateSchema = metadata?.inputSchema.properties?.predicate;
  assert.deepEqual(predicateSchema?.enum, IS_PREDICATES);
});

test('the CLI refuses scoped and depth-limited absence captures as INVALID_ARGS', () => {
  for (const [flag, value] of [
    ['snapshotScope', 'Login'],
    ['snapshotDepth', 2],
  ] as const) {
    assert.throws(
      () =>
        readInputFromCli('is', ['absent', 'label="Gone"'], {
          ...BASE_FLAGS,
          [flag]: value,
        } as CliFlags),
      (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.code, 'INVALID_ARGS');
        assert.equal(error.details?.command, 'is');
        assert.equal(error.details?.predicate, 'absent');
        assert.equal(error.details?.rejectedOption, flag === 'snapshotScope' ? 'scope' : 'depth');
        return true;
      },
    );
  }
});
