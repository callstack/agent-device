import { bindAndroidAdbHost, type AndroidAdbHost } from './adb-host.ts';

export function bindAndroidImeTestHost(): (stateDir: string) => string[] {
  const markers = new Map<string, Set<string>>();
  const markerSet = (stateDir: string) => {
    const entries = markers.get(stateDir) ?? new Set<string>();
    markers.set(stateDir, entries);
    return entries;
  };
  bindAndroidAdbHost({
    environment: {},
    files: {
      access: async () => {
        throw new Error('unexpected file access');
      },
      ensureDirectory: async () => {
        throw new Error('unexpected directory creation');
      },
      isExecutable: async () => false,
      makeTempDirectory: async () => {
        throw new Error('unexpected temporary directory');
      },
      readBytes: async () => {
        throw new Error('unexpected file read');
      },
      readDirectory: async () => {
        throw new Error('unexpected directory read');
      },
      readText: async () => {
        throw new Error('unexpected text read');
      },
      remove: async () => {
        throw new Error('unexpected file removal');
      },
      sha256: () => {
        throw new Error('unexpected checksum');
      },
      stat: async () => {
        throw new Error('unexpected stat');
      },
      writeAtomicText: async () => {
        throw new Error('unexpected file write');
      },
      writeBytes: async () => {
        throw new Error('unexpected byte write');
      },
    },
    execAdb: async () => {
      throw new Error('unexpected host ADB');
    },
    spawnAdb: () => {
      throw new Error('unexpected host ADB spawn');
    },
    withAdbCommandExecutorOverride: async (_override, fn) => await fn(),
    withoutAdbCommandExecutorOverride: async (fn) => await fn(),
    coerceAdbResult: (result) => result,
    execFailureDetails: (result) => ({ exitCode: result.exitCode }),
    emitDiagnostic: () => {},
    imeRecoveryMarkers: {
      write: async (stateDir, serial) => {
        markerSet(stateDir).add(serial);
        return true;
      },
      clear: async (stateDir, serial) => {
        markerSet(stateDir).delete(serial);
      },
      read: async (stateDir) => [...markerSet(stateDir)],
    },
    ensureHelperInstalled: async () => ({
      packageName: 'com.callstack.agentdevice.imehelper',
      versionCode: 1,
      installed: false,
      reason: 'current',
    }),
    resolveHelperArtifact: async () => {
      throw new Error('provider artifact expected');
    },
  } satisfies AndroidAdbHost);
  return (stateDir) => [...markerSet(stateDir)];
}
