import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  exportedConstArrayValues,
  exportedConstObject,
  parseTs,
  readRepoFile,
  runnerProductionSources,
  swiftEnumBody,
  swiftEnumWireCodes,
  swiftEnumWireConstants,
  swiftUpperSnakeLiterals,
  type SwiftUpperSnakeLiteral,
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
 * silently split before), and every UPPER_SNAKE string literal in production runner Swift is
 * accounted for by its value and file alone, so `ErrorPayload(code: "NEW_CODE")` fails here
 * however the expression is wrapped, instead of shipping a code no host path classifies.
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
 * UPPER_SNAKE literals that are not wire codes, per (file, literal): the two top-level codes HTTP
 * framing names itself (it rejects a request before the runner's session model exists and stays
 * standalone), `safely(...)` work labels, localization keys, an environment name and an HTTP
 * method. A new literal fails the guard until it is a constant of a wire enum or a pair here, so
 * adding a pair is the explicit statement that the literal never travels as a code.
 */
const WAIVED_LITERALS: ReadonlyMap<string, ReadonlySet<string>> = new Map(
  Object.entries({
    'RunnerHttpRequestFraming.swift': ['INVALID_ARGS', 'POST'],
    'RunnerLaunchConfirmationPrompt.swift': [
      'SCHEME_APPROVAL_DO_NOT_OPEN_BUTTON',
      'SCHEME_APPROVAL_OPEN_BUTTON',
      'SCHEME_APPROVAL_PROMPT_TITLE_NO_SOURCE',
    ],
    'RunnerRequestPanel.swift': ['LIT_PANEL_APP_IDENTITY'],
    'RunnerSystemPromptStrings.swift': [
      'SCHEME_APPROVAL_DO_NOT_OPEN_BUTTON',
      'SCHEME_APPROVAL_OPEN_BUTTON',
    ],
    'RunnerTests+Alert.swift': ['ALERT_BUTTON_HITTABLE', 'ALERT_TITLE', 'ALERT_WINDOW'],
    'RunnerTests+Keyboard.swift': ['KEYBOARD_FRAME'],
    'RunnerTests+SnapshotAcquisition.swift': [
      'SNAPSHOT_INTERFACE_ORIENTATION',
      'SNAPSHOT_VIEWPORT',
    ],
    'RunnerTests+SnapshotBridge.swift': ['SIMULATOR_UDID'],
    'RunnerTests+SystemModal.swift': ['MODAL_CONTENT', 'MODAL_NODE', 'MODAL_QUERY'],
    'RunnerTests+TextEntryFocus.swift': ['LAST_TAPPED_TEXT_INPUT_EXISTS'],
    'RunnerTests+TextEntryReadiness.swift': [
      'FOCUSED_INPUT_QUERY',
      'KEYBOARD_EXISTS',
      'TEXT_ENTRY_FOCUS_CONFIRMED',
      'TEXT_ENTRY_READINESS_FRAME',
    ],
    'RunnerTests+TextInputProbe.swift': ['TEXT_INPUT_AT_POINT'],
  }).map(([file, literals]) => [file, new Set(literals)]),
);

/**
 * The runner's log-mark and environment-variable namespace. It passes only as a direct `NSLog(`
 * argument or `environment[` key, and no wire code may use it.
 */
const NON_CODE_PREFIX = 'AGENT_DEVICE_';

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

/**
 * Whether a literal outside the declaration enums is accounted for: a family code, a log mark or
 * environment name, a raw-value `case` that spells declared vocabulary (Swift requires a literal
 * there), or a waived (file, literal) pair.
 */
function isAccountedFor(literal: SwiftUpperSnakeLiteral): boolean {
  const { file, code, rawValueCase, markOrEnvName } = literal;
  if (FAMILY_CODE_LITERALS.has(code)) return true;
  if (markOrEnvName && code.startsWith(NON_CODE_PREFIX)) return true;
  if (rawValueCase && declaredCodes.has(code)) return true;
  return WAIVED_LITERALS.get(file)?.has(code) === true;
}

/** The production sources with the two declaration enum bodies blanked, line numbers kept. */
function sourcesOutsideDeclarations(): Array<{ file: string; source: string }> {
  const blank = (body: string) => body.replaceAll(/[^\n]/g, '');
  return productionSources.map(({ file, source }) => ({
    file,
    source:
      file === RUNNER_TESTS.split('/').pop()
        ? source
            .replace(swiftEnumBody(swiftSource, 'RunnerWireErrorCode'), blank)
            .replace(swiftEnumBody(swiftSource, 'RunnerPassThroughErrorCode'), blank)
        : source,
  }));
}

test('every UPPER_SNAKE literal in production runner Swift is accounted for', () => {
  const literals = swiftUpperSnakeLiterals(sourcesOutsideDeclarations());
  const offenders = literals.filter((literal) => !isAccountedFor(literal));
  assert.deepEqual(
    offenders.map(({ file, line, code }) => `${file}:${line} "${code}"`),
    [],
    'a new runner code is a table row or a pass-through member, emitted through its enum ' +
      'constant; a literal that never travels as a code is a WAIVED_LITERALS pair',
  );
  const namespaced = [...declaredCodes].filter((code) => code.startsWith(NON_CODE_PREFIX));
  assert.deepEqual(namespaced, [], `wire codes may not use the ${NON_CODE_PREFIX} namespace`);
  const stale = [...WAIVED_LITERALS].flatMap(([file, waived]) =>
    [...waived]
      .filter((code) => !literals.some((literal) => literal.file === file && literal.code === code))
      .map((code) => `${file} "${code}"`),
  );
  assert.deepEqual(stale, [], 'a waived pair no source spells any more must be deleted');
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

test('the literal guard measures a literal wherever it is written', () => {
  // The allowlist for inline family literals must not drift from the kernel's own declaration.
  for (const code of FAMILY_CODE_LITERALS) {
    assert.ok(knownAppErrorCodes.includes(code), `${code} is not a KNOWN_APP_ERROR_CODES member`);
  }
  const source = [
    'let e = ErrorPayload(code: "NEW_REFUSAL")',
    'let ok = ErrorPayload(code: "COMMAND_FAILED")', // family code
    'case refused = "RAW_REFUSAL"', // raw value outside the declared vocabulary
    'case known = "RUNNER_BUSY"', // raw value that spells a declared row
    'let hoisted = "RUNNER_BUSY"', // a declared code outside its constant
    'NSLog("AGENT_DEVICE_RUNNER_LOG_MARK")',
    'let p = ErrorPayload(code: "AGENT_DEVICE_NEW_REFUSAL")', // the namespace alone is no pass
    'let payload = ErrorPayload(code: fallback ??',
    '  lookup(["WRAPPED_CODE"]))',
    'return',
    'NSLog("UNLISTED_MARK") // "COMMENTED_OUT"',
  ].join('\n');
  const literals = swiftUpperSnakeLiterals([{ file: 'Fixture.swift', source }]);
  assert.deepEqual(
    literals
      .filter((literal) => !isAccountedFor(literal))
      .map(({ line, code }) => `${line} ${code}`),
    [
      '1 NEW_REFUSAL',
      '3 RAW_REFUSAL',
      '5 RUNNER_BUSY',
      '7 AGENT_DEVICE_NEW_REFUSAL',
      '9 WRAPPED_CODE',
      '11 UNLISTED_MARK',
    ],
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
