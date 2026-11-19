import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  checkUntypedReasonLiterals,
  measureUntypedReasonLiterals,
  UNTYPED_REASON_RULE,
} from './untyped-reason-ratchet.ts';

/** A source tree: file path to source text. */
const tree = (files: Record<string, string>) => new Map<string, string>(Object.entries(files));

const A = 'packages/apple-runner/src/a.ts';
const BASELINE = {
  [A]: [{ file: A, line: 1, value: 'runner_process_exited' }],
};

test('a reason inside an AppError construction counts; other reason properties do not', () => {
  const measured = measureUntypedReasonLiterals(
    tree({
      'src/commands/wait.ts': `
        throw new AppError('X', 'm', { reason: 'wait_capture_stalled' });
        // A typed internal union outcome: never reaches error.details.reason.
        function decide(): { reason: string } { return { reason: 'internal_union_member' }; }
        // A different error class the rule does not own.
        throw new PlainError('m', { reason: 'other_family_reason' });
      `,
      // A declared table: a typed spine, and not a construction argument either.
      'packages/apple-runner/src/runner-contract.ts': `
        export const RUNNER_ERROR_CODES = {
          RUNNER_BUSY: { dispatched: 'no', reason: 'runner_busy' },
        } as const satisfies Record<string, { dispatched: string; reason?: string }>;
      `,
      'packages/apple-runner/src/__tests__/x.test.ts': `new AppError('X', 'm', { reason: 'test_only' });`,
    }),
  );
  assert.deepEqual(measured, {
    'src/commands/wait.ts': [
      { file: 'src/commands/wait.ts', line: 2, value: 'wait_capture_stalled' },
    ],
  });
});

test('subclass constructions and their own super() call count as wire publications', () => {
  const measured = measureUntypedReasonLiterals(
    tree({
      'packages/capture-kit/src/source-channel.ts': `
        export class SnapshotSourceError extends AppError {
          constructor(kind: string) {
            super('COMMAND_FAILED', 'm', {
              ...(kind === 'cancelled' ? { reason: 'request_canceled' } : {}),
            });
          }
        }
      `,
      'packages/platform-apple/src/consumer.ts': `
        throw new SnapshotSourceError('timeout');
        throw new AppError('X', 'm', { reason: 'consumer_literal' });
      `,
    }),
  );
  assert.deepEqual(Object.keys(measured), [
    'packages/capture-kit/src/source-channel.ts',
    'packages/platform-apple/src/consumer.ts',
  ]);
  assert.deepEqual(
    measured['packages/capture-kit/src/source-channel.ts']!.map(({ value }) => value),
    ['request_canceled'],
  );
  assert.deepEqual(
    measured['packages/platform-apple/src/consumer.ts']!.map(({ value }) => value),
    ['consumer_literal'],
  );
});

test('every resolvable value form counts; member reads and unresolvable expressions defer', () => {
  const measured = measureUntypedReasonLiterals(
    tree({
      'packages/apple-runner/src/a.ts': `
        const TYPED = 'from_typed_const' as const satisfies string;
        const UNTYPED = 'hoisted_but_untyped';
        export const TABLE = { busy: 'runner_busy' } as const satisfies Record<string, string>;
        export function a(code: string) {
          return new AppError('X', 'm', {
            reason: TYPED,                       // as-const scalar: still evaluates to its literal
            ...(code === 'b' ? { reason: UNTYPED } : {}), // hoist through a conditional: counts
            reason2: TABLE.busy,                 // not the reason key
          });
        }
        export function c() {
          return new AppError('X', 'm', { reason: TABLE['busy'] }); // member expression: defers
        }
        export function d(n: number) {
          return new AppError('X', 'm', { reason: \`wait_poll_\${n}\` }); // substitution: unresolvable
        }
        export function e() {
          return new AppError('X', 'm', { reason: 'plain_template' as unknown as string });
        }
        export function f(timedOut: boolean) {
          return new AppError('X', 'm', { reason: timedOut ? 'brand_new' : UNTYPED });
        }
        export function g() {
          return new AppError('X', 'm', { reason: fallback() ?? 'from_logical' });
        }
      `,
    }),
  );
  assert.deepEqual(measured[A]!.map(({ value }) => value).sort(), [
    'brand_new',
    'from_logical',
    'from_typed_const',
    'hoisted_but_untyped',
    'hoisted_but_untyped', // the spread-conditional in a() and the ternary in f(): two sites
    'plain_template',
  ]);
});

test('a quoted key counts like the bare identifier key', () => {
  const measured = measureUntypedReasonLiterals(
    tree({ [A]: `new AppError('X', 'm', { 'reason': 'quoted_key' });` }),
  );
  assert.deepEqual(
    measured[A]!.map(({ value }) => value),
    ['quoted_key'],
  );
});

test('an exported const hoist counts: export does not launder the literal', () => {
  const measured = measureUntypedReasonLiterals(
    tree({
      [A]: `
        export const REASON = 'brand_new';
        export const TYPED = 'typed_export' as const;
        throw new AppError('X', 'm', { reason: REASON });
        throw new AppError('X', 'm', { reason: TYPED });
      `,
    }),
  );
  assert.deepEqual(measured[A]!.map(({ value }) => value).sort(), ['brand_new', 'typed_export']);
});

test('a reason under another details property is not the published reason', () => {
  const measured = measureUntypedReasonLiterals(
    tree({
      [A]: `
        new AppError('X', 'm', {
          reason: 'known_top_level',
          cause: { reason: 'internal_detail' },
          context: [{ reason: 'array_nested' }],
        });
        new AppError('X', 'm', { ...extra, ...(flag ? { reason: 'spread_conditional' } : {}) });
      `,
    }),
  );
  assert.deepEqual(
    measured[A]!.map(({ value }) => value),
    ['known_top_level', 'spread_conditional'],
  );
});

test('R89 is quiet while every published value exists at the merge-base, and banks a shrink', () => {
  const same = measureUntypedReasonLiterals(
    tree({ [A]: `new AppError('X', 'm', { reason: 'runner_process_exited' });` }),
  );
  assert.deepEqual(checkUntypedReasonLiterals(same, BASELINE), []);
  assert.deepEqual(checkUntypedReasonLiterals({}, BASELINE), []);
});

test('replacing a value in place fails even at the same count', () => {
  // One site stays one site; only the VALUE is new. A count ratchet passes this.
  const renamed = measureUntypedReasonLiterals(
    tree({ [A]: `new AppError('X', 'm', { reason: 'brand_new' });` }),
  );
  assert.equal(renamed[A]!.length, 1);
  const violations = checkUntypedReasonLiterals(renamed, BASELINE);
  assert.equal(violations.length, 1);
  assert.equal(violations[0]!.rule, UNTYPED_REASON_RULE);
  assert.equal(violations[0]!.file, A);
  assert.match(violations[0]!.message, /publishes reason: 'brand_new'/);
});

test('R89 flags a new value in a new file and reports one violation per new value', () => {
  const grown = measureUntypedReasonLiterals(
    tree({
      'packages/apple-runner/src/b.ts': `
        new AppError('X', 'm', { reason: 'runner_new_refusal' });
        new AppError('Y', 'm', { reason: 'runner_second_refusal' });
      `,
    }),
  );
  const violations = checkUntypedReasonLiterals(grown, BASELINE);
  assert.deepEqual(
    violations.map(({ file, message }) => `${file} ${/reason: '(\w+)'/.exec(message)?.[1]}`),
    [
      'packages/apple-runner/src/b.ts runner_new_refusal',
      'packages/apple-runner/src/b.ts runner_second_refusal',
    ],
  );
});

test('a value moved between two files fails: the target file never published it', () => {
  const moved = measureUntypedReasonLiterals(
    tree({
      [A]: `export const OK = 1;`,
      'packages/apple-runner/src/b.ts': `new AppError('X', 'm', { reason: 'runner_process_exited' });`,
    }),
  );
  const violations = checkUntypedReasonLiterals(moved, BASELINE);
  assert.equal(violations.length, 1);
  assert.equal(violations[0]!.file, 'packages/apple-runner/src/b.ts');
});

test('an aliased AppError import still constructs a measured site', () => {
  const measured = measureUntypedReasonLiterals(
    tree({
      [A]: `
        import { AppError as KernelAppError } from '@agent-device/kernel';
        throw new KernelAppError('X', 'm', { reason: 'aliased_construction' });
        class LocalError extends KernelAppError {}
        throw new LocalError('X', 'm', { reason: 'aliased_subclass' });
      `,
    }),
  );
  assert.deepEqual(measured[A]!.map(({ value }) => value).sort(), [
    'aliased_construction',
    'aliased_subclass',
  ]);
});

test('the documented escapes stay escapes: an imported name and a hoisted details object', () => {
  // The rule header lists these as known escapes: chasing cross-file value flow turns a ratchet
  // into a type checker. These fixtures pin THAT boundary, so a future change cannot silently
  // widen the promise the rule makes.
  const measured = measureUntypedReasonLiterals(
    tree({
      'packages/kernel/src/reasons.ts': `export const SHARED = 'imported_reason';`,
      [A]: `
        import { SHARED } from 'packages/kernel/src/reasons.ts';
        const DETAILS = { reason: 'hoisted_object' };
        new AppError('X', 'm', { reason: SHARED });
        new AppError('X', 'm', DETAILS);
        new AppError('X', 'm', { ...DETAILS });
        new AppError('X', 'm', { reason: 'the_control_counts' });
      `,
    }),
  );
  assert.deepEqual(
    measured[A]!.map(({ value }) => value),
    ['the_control_counts'],
  );
});
