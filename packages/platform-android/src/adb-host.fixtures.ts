import { bindAndroidAdbHost, type AndroidAdbHost } from './adb-host.ts';

export type AndroidAdbHostStub = AndroidAdbHost & {
  diagnostics: Array<{ phase: string; level?: string }>;
  markerStore: Map<string, Set<string>>;
};

/**
 * Binds a minimal in-memory host port for colocated unit tests: no processes, no files. Every
 * facet a test does not override answers inertly (identity wrappers, in-memory markers) or
 * throws, so a test exercising one module cannot silently lean on another's host behavior.
 */
export function bindAndroidAdbHostStub(
  overrides: Partial<AndroidAdbHost> = {},
): AndroidAdbHostStub {
  const diagnostics: AndroidAdbHostStub['diagnostics'] = [];
  const markerStore: AndroidAdbHostStub['markerStore'] = new Map();
  const markersFor = (stateDir: string): Set<string> => {
    const existing = markerStore.get(stateDir) ?? new Set<string>();
    markerStore.set(stateDir, existing);
    return existing;
  };
  const host: AndroidAdbHostStub = {
    execSerialAdb: async () => {
      throw new Error('adb-host stub: execSerialAdb not stubbed');
    },
    spawnSerialAdb: () => {
      throw new Error('adb-host stub: spawnSerialAdb not stubbed');
    },
    execHostAdb: async () => {
      throw new Error('adb-host stub: execHostAdb not stubbed');
    },
    withAdbCommandExecutorOverride: async (_override, fn) => await fn(),
    withoutAdbCommandExecutorOverride: async (fn) => await fn(),
    coerceAdbResult: (result) => result,
    execFailureDetails: (result, extra) => ({
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      processExitError: true,
      ...extra,
    }),
    emitDiagnostic: (event) => {
      diagnostics.push({ phase: event.phase, ...(event.level ? { level: event.level } : {}) });
    },
    imeRecoveryMarkers: {
      write: async (stateDir, serial) => {
        markersFor(stateDir).add(serial);
        return true;
      },
      clear: async (stateDir, serial) => {
        markersFor(stateDir).delete(serial);
      },
      read: async (stateDir) => [...markersFor(stateDir)],
    },
    resolveHelperArtifact: async () => {
      throw new Error('adb-host stub: resolveHelperArtifact not stubbed');
    },
    ensureHelperInstalled: async () => {
      throw new Error('adb-host stub: ensureHelperInstalled not stubbed');
    },
    ...overrides,
    diagnostics,
    markerStore,
  };
  bindAndroidAdbHost(host);
  return host;
}
