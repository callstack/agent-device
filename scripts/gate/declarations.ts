// The three small facts the manifest cannot derive from package scripts and workflow YAML.

export const OPAQUE_RUNNERS: Readonly<Record<string, readonly string[]>> = {
  // This wrapper runs Vitest over every project, then retries owned contention failures.
  'test:coverage:ci': [
    'vitest:unit-core',
    'vitest:subprocess-stub',
    'vitest:provider-integration',
    'vitest:interaction-contract',
    'vitest:output-economy',
  ],
};

export const REPORTING_SCRIPTS: Readonly<Record<string, string>> = {
  'test:integration:progress': [
    'Prints the provider-backed integration status table and exits 0. The assertion lives in',
    'its `--check` sibling, `test:integration:progress:check`, which IS the registered',
    '`integration-progress` gate. Running the reporter in CI would gate nothing.',
  ].join(' '),
};

export const UNPROVABLE_OWNERS: Readonly<Record<string, string>> = {
  'replay-android': [
    'Replay Nightly / Android Replay Suite runs `pnpm gate replay-android`, but inside the',
    '`script:` input of `reactivecircus/android-emulator-runner` — shell handed to a',
    'third-party action, which this loader does not read. The suite executes; the manifest',
    'cannot see it. Routing the emulator lane through steps it can read is the open item',
    'named in #1429.',
  ].join(' '),
};
