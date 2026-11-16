import path from 'node:path';

export type ReplayFormat = 'ad' | 'maestro';

const REPLAY_PLUGIN_INSTALLATIONS = {
  ad: {
    package: '@agent-device/replay',
    summary: 'Native .ad replay and test suites',
    installationHint:
      'Install on the daemon host for native .ad replay and all test suites. Core clients can read and send native .ad sources without this plugin.',
  },
  maestro: {
    package: '@agent-device/maestro',
    summary: 'Supported Maestro YAML commands, grammar, and runtime boundaries',
    installationHint:
      'Install on the client for source collection/export and on the daemon host for Maestro execution.',
  },
} as const;

/** Vetted installation facts for the replay format vocabulary, without loading an engine. */
export function getReplayPluginInstallation(id: ReplayFormat) {
  return { id, ...REPLAY_PLUGIN_INSTALLATIONS[id] };
}

export function isMaestroYamlPath(sourcePath: string): boolean {
  const extension = path.extname(sourcePath).toLowerCase();
  return extension === '.yaml' || extension === '.yml';
}

export function maestroBackendRequiredMessage(
  command: 'replay' | 'test',
  sourcePath: string,
): string {
  return `Maestro YAML requires explicit --maestro routing: ${command} ${sourcePath} --maestro`;
}

/**
 * The one wording for a `--maestro`-style backend value nothing is registered for. The client's
 * `parseReplayInput`, the daemon's plan-side flag check, and the backend registry (#3377) all
 * reject through here, so the CLI/client-facing text stays one string rather than three copies
 * kept in step by hand.
 */
export function unsupportedReplayBackendMessage(backend: string): string {
  return `Unsupported replay backend "${backend}".`;
}

/** Backend ids the grammar can route to. `'ad'` is native and never reaches a backend registry. */
export type ReplayBackendId = Exclude<ReplayFormat, 'ad'>;

/**
 * Whether a wire-level `replayBackend` value names a backend in this grammar — the vocabulary
 * check the client, the daemon's plan-side rejection, and the #3377 backend registry share, so no
 * host module compares the flag against a backend literal of its own.
 */
export function isReplayBackendId(value: string | undefined): value is ReplayBackendId {
  return value === 'maestro';
}

/**
 * Selects an engine from the authored path and explicit backend request.
 * Content is never probed and engines never fall back to one another.
 */
export function resolveReplayFormat(
  sourcePath: string,
  replayBackend: string | undefined,
): ReplayFormat {
  return replayBackend === 'maestro' && isMaestroYamlPath(sourcePath) ? 'maestro' : 'ad';
}
