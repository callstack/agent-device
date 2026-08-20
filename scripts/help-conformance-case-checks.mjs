import { opensAndCloses, usesValidationPrep } from './help-conformance-expectations.mjs';

const EXPECTATION_SCORERS = {
  validPlanCommands: ({ commands, commandValidation }) =>
    commands.length > 0 && commandValidation.every(({ issues }) => issues.length === 0),
  fullPrefix: ({ commands }) =>
    commands.length > 0 &&
    commands.every(
      (command) => !/^(open|snapshot|press|fill|click|longpress|wait|close)\b/.test(command),
    ),
  usesSnapshotI: ({ commands }) => commands.some((command) => /\bsnapshot\b.*\s-i\b/.test(command)),
  usesSettleOnMutations: ({ commands }) => allMutationsUseSettle(commands),
  // help workflow teaches chaining confident consecutive steps with an
  // unquoted &&. This reads the raw (pre-split) command lines, not `joined`
  // (canonicalPlan flattens a chain into separate lines once the plan
  // validator splits and validates each segment), so it is the only place
  // that can tell whether the model actually chained.
  usesConfidentChaining: ({ commands }) => commands.some((command) => /&&/.test(command)),
  noWaitStable: ({ joined }) => !joined.includes('wait stable'),
  verifiesNamedExpectation: ({ joined }) => /\b(wait|is|get|find)\b/.test(joined),
  usesDogfoodEvidence: ({ joined }) =>
    /(?:\bscreenshot\b|\brecord\b|\blogs\b|\bnetwork\b|\bperf\b|\btrace\b|dogfood-output)/i.test(
      joined,
    ),
  usesValidationPrep,
  opensAndCloses,
};

// The scorer registry itself, so a falsification-fixture completeness gate
// (scripts/__tests__/help-conformance-expectation-falsification.test.ts) can
// enumerate every named expectation instead of hand-maintaining a second list
// that silently drifts from EXPECTATION_SCORERS.
export const KNOWN_EXPECTATIONS = Object.keys(EXPECTATION_SCORERS);

export function assertCaseDefinitions(cases) {
  assertUniqueIds(
    cases.map(({ id }) => id),
    'benchmark case',
  );
  for (const testCase of cases) assertCaseDefinition(testCase);
}

export function countChecks(testCase) {
  return resolveChecks(testCase).length;
}

export function scoreExpectations(testCase, commands, raw, commandValidation) {
  const context = {
    commands,
    joined: canonicalPlan(commandValidation).toLowerCase(),
    raw,
    commandValidation,
  };
  return Object.fromEntries(resolveChecks(testCase).map(({ id, test }) => [id, test(context)]));
}

function resolveChecks(testCase) {
  const named = (testCase.expectations ?? []).map((id) => ({
    id,
    test: (context) => scoreExpectation(id, context),
  }));
  const matched = (testCase.matchers ?? []).map(({ id, pattern }) => ({
    id,
    test: (context) => pattern.test(context.joined),
  }));
  const forbidden = (testCase.forbidden ?? []).map(({ id, pattern }) => ({
    id,
    test: (context) => !pattern.test(context.joined),
  }));
  return [...named, ...matched, ...forbidden];
}

function canonicalPlan(commandValidation) {
  return commandValidation.map(({ tokens }) => tokens.map(canonicalToken).join(' ')).join('\n');
}

function canonicalToken(token) {
  return /\s/.test(token) ? JSON.stringify(token) : token;
}

function assertCaseDefinition(testCase) {
  const unknownExpectation = (testCase.expectations ?? []).find(
    (expectation) => !(expectation in EXPECTATION_SCORERS),
  );
  if (unknownExpectation) {
    throw new Error(`Unknown expectation "${unknownExpectation}" in case "${testCase.id}".`);
  }
  assertUniqueIds(
    resolveChecks(testCase).map(({ id }) => id),
    `check in case "${testCase.id}"`,
  );
}

function assertUniqueIds(ids, label) {
  const seen = new Set();
  const duplicates = new Set();
  for (const id of ids) {
    if (seen.has(id)) duplicates.add(id);
    seen.add(id);
  }
  if (duplicates.size > 0) {
    throw new Error(`Duplicate ${label} id(s): ${[...duplicates].join(', ')}`);
  }
}

function scoreExpectation(expectation, context) {
  const scorer = EXPECTATION_SCORERS[expectation];
  if (!scorer) throw new Error(`Unknown expectation: ${expectation}`);
  return scorer(context);
}

function allMutationsUseSettle(commands) {
  const mutating = commands.filter(isMutationCommand);
  return mutating.length > 0 && mutating.every((command) => command.includes('--settle'));
}

function isMutationCommand(command) {
  return /^agent-device\s+(?:press|click|fill|longpress)\b/.test(command);
}
