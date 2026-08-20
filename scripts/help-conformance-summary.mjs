export function summarizeResults(results) {
  const groups = new Map();
  for (const result of results) {
    const key = `${result.runner}\0${result.caseId}`;
    const group = groups.get(key) ?? {
      runner: result.runner,
      caseId: result.caseId,
      trials: 0,
      evaluatedTrials: 0,
      passed: 0,
      failedChecks: {},
      validationIssues: {},
      runnerErrors: 0,
    };
    group.trials += 1;
    if (result.runnerError) {
      group.runnerErrors += 1;
    } else {
      group.evaluatedTrials += 1;
      if (result.passed) group.passed += 1;
      countFailedChecks(group.failedChecks, result.checks);
      countValidationIssues(group.validationIssues, result.commandValidation);
    }
    groups.set(key, group);
  }
  // A group with zero evaluated trials (every trial was a runner error) has
  // no pass rate to report — 0 would silently read as "0% correct" instead
  // of "the model was never actually graded".
  return [...groups.values()].map((group) => ({
    ...group,
    passRate: group.evaluatedTrials === 0 ? null : group.passed / group.evaluatedTrials,
  }));
}

function countFailedChecks(counts, checks = {}) {
  for (const [id, passed] of Object.entries(checks)) {
    if (!passed) counts[id] = (counts[id] ?? 0) + 1;
  }
}

function countValidationIssues(counts, commandValidation = []) {
  for (const command of commandValidation) {
    for (const issue of command.issues ?? []) {
      counts[issue.kind] = (counts[issue.kind] ?? 0) + 1;
    }
  }
}
