const APPLE_RUNNER_DIAGNOSTIC_RESULT_FIELDS = [
  'currentUptimeMs',
  'gestureEndUptimeMs',
  'gestureStartUptimeMs',
  'sequenceResults',
] as const;

const appleRunnerDiagnosticResultFields = new Set<string>(APPLE_RUNNER_DIAGNOSTIC_RESULT_FIELDS);

export function normalizeAppleRunnerResultForResponse(
  data: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!data) return undefined;
  return Object.fromEntries(
    Object.entries(data).filter(([key]) => !appleRunnerDiagnosticResultFields.has(key)),
  );
}
