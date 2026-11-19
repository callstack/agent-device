import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  exportedConstArrayValues,
  exportedConstObject,
  parseTs,
  readRepoFile,
  runnerProductionSources,
  swiftCodeLiteralSites,
  swiftEnumBody,
  swiftEnumWireCodes,
  swiftEnumWireConstants,
  unwrapAssertion,
} from './runner-source-assertions.ts';

/**
 * The runner's wire vocabulary is closed. Every code the runner Swift puts on the wire is one of:
 * a row of the daemon's `RUNNER_ERROR_CODES` table (emitted through the Swift
 * `RunnerWireErrorCode` enum), a member of the pass-through list below (emitted through the Swift
 * `RunnerPassThroughErrorCode` enum), or a top-level `KNOWN_APP_ERROR_CODES` family code written
 * as a literal at the emit site (`COMMAND_FAILED`, `UNSUPPORTED_OPERATION`, `UNAUTHORIZED`). This
 * guard reads the production runner Swift and the TypeScript declarations: the two sides match
 * 1:1 per set, every Swift constant is actually referenced (a dead constant is how this pair
 * silently split before), and no production runner file puts an unlisted UPPER_SNAKE code literal
 * where a code travels — a `code:` argument, a `let`/`return` binding, or a raw-value `case` —
 * so `ErrorPayload(code: "NEW_CODE")` fails here instead of shipping a code no host path
 * classifies. Raw-value enum cases keep their literals (Swift requires one), so their rule is
 * closure over the declared vocabulary, not routing through the wire enums.
 */

const CONTRACT = 'packages/apple-runner/src/runner-contract.ts';
const KERNEL_ERRORS = 'packages/kernel/src/errors.ts';
const RUNNER_TESTS = 'apple/runner/AgentDeviceRunner/AgentDeviceRunnerUITests/RunnerTests.swift';

/**
 * Top-level family codes the runner writes as literals: they belong to the daemon's own
 * `KNOWN_APP_ERROR_CODES`, not to the runner's wire enums.
 */
const FAMILY_CODE_LITERALS = new Set(['COMMAND_FAILED', 'UNSUPPORTED_OPERATION', 'UNAUTHORIZED']);

/**
 * Literals the closed-vocabulary rule waives per file: HTTP framing rejects requests before the
 * runner's session model exists and stays standalone, so it writes these two top-level codes as
 * literals in its computed `var code`. The waiver is per (file, code), not per file, and the scan
 * now really sees those lines (a computed `code` property stays open across lines): a third code
 * written there is measured and fails.
 */
const WAIVED_LITERALS = new Map([
  ['RunnerHttpRequestFraming.swift', new Set(['UNAUTHORIZED', 'INVALID_ARGS'])],
]);

const productionSources = runnerProductionSources();
const swiftSource = readRepoFile(RUNNER_TESTS);
const tableKeys = runnerErrorCodeTableKeys(readRepoFile(CONTRACT));
/**
 * The runner codes the host does not classify: they get no row of `RUNNER_ERROR_CODES`, so
 * `classifyRunnerReportedError` hands each one to `toAppErrorCode`, which publishes it verbatim as
 * the command's own `AppError.code`. They are pass-through in the sense that no host policy reads
 * them — no reason, no retriable flag, no dispatch disclosure beyond the generic one — not in the
 * sense that they hide inside details. This list is the declaration of that surface: the Swift
 * `RunnerPassThroughErrorCode` enum is the half the emitters use, and the tests below check the
 * two 1:1, so a code the runner starts emitting fails here until it lands in this list or in the
 * table. A code the host learns to branch on graduates to a table row, never to a longer copy of
 * this list.
 */
const RUNNER_PASS_THROUGH_CODES = [
  'TEXT_ENTRY_MISMATCH', // `fill` read-back found different text than it typed
  'TEXT_INPUT_NOT_FOCUSED',
  'TEXT_INPUT_SYNTHESIS_UNAVAILABLE',
  'TEXT_INPUT_COMMIT_NOT_OBSERVED',
  'TEXT_INPUT_CLEAR_NOT_OBSERVED',
  'TEXT_INPUT_SYNTHESIS_BUDGET_EXCEEDED',
  'XCTEST_RECORDED_FAILURE', // the failure was recorded by XCTest itself
  'ALERT_DEADLINE_EXCEEDED',
  'ALERT_CONFIRMATION_UNAVAILABLE',
  'IOS_TREE_CAPTURE_TIMEOUT',
  'IOS_AX_SNAPSHOT_FAILED',
  'IOS_RAW_SNAPSHOT_TOO_LARGE',
  'IOS_SNAPSHOT_TOO_LARGE',
  'IOS_SNAPSHOT_PROJECTION_MISMATCH',
  'IOS_SNAPSHOT_PRESENTATION_FAILED',
] as const;

const passThroughCodes: string[] = [...RUNNER_PASS_THROUGH_CODES];
/** Everything the closed vocabulary allows a literal to spell (raw-value cases and family codes). */
const declaredCodes = new Set([...tableKeys, ...passThroughCodes, ...FAMILY_CODE_LITERALS]);
const knownAppErrorCodes = exportedConstArrayValues(
  readRepoFile(KERNEL_ERRORS),
  'KNOWN_APP_ERROR_CODES',
);

test('RUNNER_ERROR_CODES and the Swift RunnerWireErrorCode enum declare exactly the same codes', () => {
  assertSetsMatch(
    tableKeys,
    swiftEnumWireCodes(swiftSource, 'RunnerWireErrorCode'),
    'RUNNER_ERROR_CODES',
    'RunnerWireErrorCode',
  );
});

test('RUNNER_PASS_THROUGH_CODES and the Swift RunnerPassThroughErrorCode enum match', () => {
  assertSetsMatch(
    passThroughCodes,
    swiftEnumWireCodes(swiftSource, 'RunnerPassThroughErrorCode'),
    'RUNNER_PASS_THROUGH_CODES',
    'RunnerPassThroughErrorCode',
  );
});

test('the two declarations are disjoint and exclude the family codes', () => {
  const overlap = tableKeys.filter((code) => passThroughCodes.includes(code));
  assert.deepEqual(
    overlap,
    [],
    `declared as both a classified row and a pass-through code: ${overlap.join(', ')}`,
  );
  const familyInRunnerSets = [...FAMILY_CODE_LITERALS].filter(
    (code) => tableKeys.includes(code) || passThroughCodes.includes(code),
  );
  assert.deepEqual(
    familyInRunnerSets,
    [],
    `family codes must stay top-level KNOWN_APP_ERROR_CODES, not runner wire codes: ${familyInRunnerSets.join(', ')}`,
  );
});

test('every declared Swift code constant is emitted, not just declared', () => {
  const constants = new Map<string, string>();
  for (const enumName of ['RunnerWireErrorCode', 'RunnerPassThroughErrorCode'] as const) {
    for (const { name, code } of swiftEnumWireConstants(swiftSource, enumName)) {
      constants.set(code, `${enumName}.${name}`);
    }
  }
  const bodyless = productionSources
    .map(({ source }) => source)
    .join('\n')
    .replace(swiftEnumBody(swiftSource, 'RunnerWireErrorCode'), '')
    .replace(swiftEnumBody(swiftSource, 'RunnerPassThroughErrorCode'), '');
  const dead = [...tableKeys, ...passThroughCodes].filter((code) => {
    const constant = constants.get(code);
    return (
      constant === undefined ||
      !new RegExp(`\\b${constant.replaceAll('.', String.raw`\.`)}\\b`).test(bodyless)
    );
  });
  assert.deepEqual(
    dead,
    [],
    `declared but never emitted through the enum: ${dead.join(', ')} — route the emit site ` +
      'through the constant or delete it, or the set stops describing what the runner emits',
  );
});

test('production runner code puts no undeclared code literal where a code travels', () => {
  // `code:` arguments and let/return bindings may hold only a family code: every runner code
  // travels through its enum constant. A raw-value `case` must spell a literal (Swift requires
  // one), so its rule is closure: the code is declared vocabulary. RunnerTests.swift keeps its
  // declaration enums: those static lets ARE the vocabulary, so their bodies are blanked first.
  const scanned = swiftCodeLiteralSites(
    productionSources.map(({ file, source }) =>
      file === RUNNER_TESTS.split('/').pop()
        ? {
            file,
            source: source
              .replace(swiftEnumBody(swiftSource, 'RunnerWireErrorCode'), '')
              .replace(swiftEnumBody(swiftSource, 'RunnerPassThroughErrorCode'), ''),
          }
        : { file, source },
    ),
  );
  const offenders = scanned.filter(({ file, code, kind }) => {
    if (WAIVED_LITERALS.get(file)?.has(code) === true) return false;
    return kind === 'rawValue' ? !declaredCodes.has(code) : !FAMILY_CODE_LITERALS.has(code);
  });
  assert.deepEqual(
    offenders,
    [],
    `puts a code literal where a code travels, outside the closed vocabulary: ${offenders
      .map(({ file, line, code, kind }) => `${file}:${line} "${code}" (${kind})`)
      .join(', ')} — a new runner code is a table row or a pass-through member, emitted ` +
      'through its constant',
  );
});

test('deleting a Swift constant fails the parity guard', () => {
  const withoutOne = swiftSource.replace('    static let runnerBusy = "RUNNER_BUSY"\n', '');
  assert.notEqual(withoutOne, swiftSource, 'the fixture must actually remove one constant');
  assert.throws(
    () =>
      assertSetsMatch(
        tableKeys,
        swiftEnumWireCodes(withoutOne, 'RunnerWireErrorCode'),
        'RUNNER_ERROR_CODES',
        'RunnerWireErrorCode',
      ),
    /RUNNER_ERROR_CODES declares RUNNER_BUSY but RunnerWireErrorCode does not/,
  );
});

test('the literal guard allows only codes the kernel declares as top-level', () => {
  // The allowlist for inline family literals must not drift from the kernel's own declaration.
  for (const code of FAMILY_CODE_LITERALS) {
    assert.ok(knownAppErrorCodes.includes(code), `${code} is not a KNOWN_APP_ERROR_CODES member`);
  }
  const fixture = [
    {
      file: 'Fixture.swift',
      source: [
        'let e = ErrorPayload(code: "NEW_REFUSAL")', // emit: not a family code -> offender
        'let ok = ErrorPayload(code: "COMMAND_FAILED")', // emit: family code -> allowed
        'static let hoisted = "BRAND_NEW"', // binding: same rule as emit
        'return "SNEAKED"', // binding: same rule as emit
        'case refused = "RAW_REFUSAL"', // rawValue: undeclared -> offender
        'case known = "RUNNER_BUSY"', // rawValue: declared row -> allowed
        'NSLog("AGENT_DEVICE_RUNNER_LOG_MARK")', // not a code position at all
        'var code: String {', // a computed code property stays open across lines...
        '  "MULTILINE_REFUSAL"', // ...so this literal IS the code position (emit)
        '}',
        'let payload = ErrorPayload(',
        '  code:', // a bare code: label stays open too
        '    "WRAPPED_CODE",',
        ')',
        'return payload // `return` with no literal on its line is not a binding',
      ].join('\n'),
    },
  ];
  const scanned = swiftCodeLiteralSites(fixture);
  assert.deepEqual(
    scanned.map(({ line, code, kind }) => `${line} ${code} ${kind}`),
    [
      '1 NEW_REFUSAL emit',
      '2 COMMAND_FAILED emit',
      '3 BRAND_NEW binding',
      '4 SNEAKED binding',
      '5 RAW_REFUSAL rawValue',
      '6 RUNNER_BUSY rawValue',
      '9 MULTILINE_REFUSAL emit',
      '13 WRAPPED_CODE emit',
    ],
  );
  assert.deepEqual(
    scanned
      .filter(({ code, kind }) =>
        kind === 'rawValue' ? !declaredCodes.has(code) : !FAMILY_CODE_LITERALS.has(code),
      )
      .map(({ code }) => code),
    ['NEW_REFUSAL', 'BRAND_NEW', 'SNEAKED', 'RAW_REFUSAL', 'MULTILINE_REFUSAL', 'WRAPPED_CODE'],
  );
});

/** Exact 1:1 set equality between the TypeScript declaration and the Swift enum. */
function assertSetsMatch(
  tsCodes: string[],
  swiftCodes: string[],
  tsName: string,
  swiftName: string,
): void {
  const missingInSwift = tsCodes.filter((code) => !swiftCodes.includes(code));
  const missingInTs = swiftCodes.filter((code) => !tsCodes.includes(code));
  assert.deepEqual(
    missingInSwift,
    [],
    `${tsName} declares ${missingInSwift.join(', ')} but ${swiftName} does not: add a ` +
      '`static let` per code in RunnerTests.swift.',
  );
  assert.deepEqual(
    missingInTs,
    [],
    `${swiftName} declares ${missingInTs.join(', ')} but ${tsName} has no row for it: add one ` +
      `in ${CONTRACT}.`,
  );
}

/** Every table key of the exported `RUNNER_ERROR_CODES` table. */
function runnerErrorCodeTableKeys(source: string): string[] {
  const table = exportedConstObject(parseTs(CONTRACT, source), 'RUNNER_ERROR_CODES');
  const keys: string[] = [];
  for (const property of table.properties) {
    assert.ok(
      property.type === 'Property' && !property.computed && property.key.type === 'Identifier',
      `unsupported row key in RUNNER_ERROR_CODES: ${property.type}`,
    );
    const row = unwrapAssertion(property.value);
    assert.ok(
      row?.type === 'ObjectExpression',
      `unsupported row in RUNNER_ERROR_CODES for ${property.key.name}`,
    );
    keys.push(property.key.name);
  }
  assert.ok(keys.length > 0, 'RUNNER_ERROR_CODES must declare at least one row');
  return keys;
}
