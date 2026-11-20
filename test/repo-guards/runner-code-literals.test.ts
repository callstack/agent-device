import assert from 'node:assert/strict';
import { test } from 'vitest';
import { KNOWN_APP_ERROR_CODES } from '@agent-device/kernel/errors';
import {
  GENERATED_SWIFT_FILE,
  RUNNER_CODE_ENUMS,
  swiftConstantName,
} from '../../scripts/generate-runner-error-codes.ts';
import {
  runnerProductionSources,
  swiftUpperSnakeLiterals,
  type SwiftUpperSnakeLiteral,
} from './runner-source-assertions.ts';

/**
 * The runner's wire vocabulary is closed. Every code the runner Swift puts on the wire is one of:
 * a row of the daemon's `RUNNER_ERROR_CODES` table, a member of `RUNNER_PASS_THROUGH_CODES`, or a
 * top-level `KNOWN_APP_ERROR_CODES` family code written as a literal at the emit site
 * (`COMMAND_FAILED`, `UNSUPPORTED_OPERATION`, `UNAUTHORIZED`). The generator
 * (scripts/generate-runner-error-codes.ts) writes the Swift enums from the two declarations, so
 * the declarations cannot differ. It cannot see a Swift emit site, and `ErrorPayload.code` is a
 * `String`, so the compiler accepts any literal there. This guard covers that gap: every
 * UPPER_SNAKE string literal in the hand-written production runner Swift is accounted for by its
 * value and file alone, so `ErrorPayload(code: "NEW_CODE")` fails here however the expression is
 * wrapped, and every generated constant is referenced by an emit site.
 */

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

/** The hand-written production sources: the generated enums are declarations, not emit sites. */
const emitSources = runnerProductionSources().filter(({ file }) => file !== GENERATED_SWIFT_FILE);
/** Everything the closed vocabulary allows a literal to spell (raw-value cases and family codes). */
const declaredCodes = new Set([
  ...Object.values(RUNNER_CODE_ENUMS).flat(),
  ...FAMILY_CODE_LITERALS,
]);

test('every generated Swift code constant is emitted, not just declared', () => {
  const emitted = emitSources.map(({ source }) => source).join('\n');
  const dead = Object.entries(RUNNER_CODE_ENUMS).flatMap(([enumName, codes]) =>
    codes.filter(
      (code) => !new RegExp(`\\b${enumName}\\.${swiftConstantName(code)}\\b`).test(emitted),
    ),
  );
  assert.deepEqual(
    dead,
    [],
    `declared but never emitted through the enum: ${dead.join(', ')} — route the emit site ` +
      'through the constant or delete the declaration in runner-contract.ts',
  );
});

/**
 * Whether a literal in the hand-written sources is accounted for: a family code, a log mark or
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

test('every UPPER_SNAKE literal in production runner Swift is accounted for', () => {
  const literals = swiftUpperSnakeLiterals(emitSources);
  const offenders = literals.filter((literal) => !isAccountedFor(literal));
  assert.deepEqual(
    offenders.map(({ file, line, code }) => `${file}:${line} "${code}"`),
    [],
    'a new runner code is a RUNNER_ERROR_CODES row or a RUNNER_PASS_THROUGH_CODES member, ' +
      'emitted through its generated constant; a literal that never travels as a code is a WAIVED_LITERALS pair',
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

test('the literal guard measures a literal wherever it is written', () => {
  // The allowlist for inline family literals must not drift from the kernel's own declaration.
  for (const code of FAMILY_CODE_LITERALS) {
    assert.ok(
      (KNOWN_APP_ERROR_CODES as readonly string[]).includes(code),
      `${code} is not a KNOWN_APP_ERROR_CODES member`,
    );
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
