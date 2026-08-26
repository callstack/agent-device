import type {
  AndroidHelperInstallDecision,
  AndroidImeHelperArtifact,
} from '@agent-device/contracts/android-helper-artifacts';
import type {
  AndroidAdbExecutor,
  AndroidAdbExecutorOptions,
  AndroidAdbExecutorResult,
  AndroidAdbProcess,
  AndroidAdbProvider,
  AndroidAdbSpawnOptions,
} from './adb-transport.ts';

// R13 bars platform packages from raw process, fs, and ambient host authority; the adb/IME
// cluster reaches those primitives only through this explicitly injected host port. The root
// composition wiring (src/platforms/android/adb-host-binding.ts) binds it before any consumer
// can call into the cluster.

export type AndroidAdbCommandExecutorOverride = (
  cmd: string,
  args: string[],
  options: AndroidAdbExecutorOptions,
) => Promise<AndroidAdbExecutorResult> | undefined;

export type AndroidAdbDiagnosticEvent = {
  level?: 'info' | 'warn' | 'error' | 'debug';
  phase: string;
  durationMs?: number;
  data?: Record<string, unknown>;
};

export type AndroidAdbHost = Readonly<{
  /**
   * Device-scoped local adb execution for `serial`, escaping any active command-executor
   * override (a tunnel-backed provider shelling out to adb must not route back into itself)
   * and owning the host-side process-group/teardown semantics.
   */
  execSerialAdb(
    serial: string,
    args: string[],
    options?: AndroidAdbExecutorOptions,
  ): Promise<AndroidAdbExecutorResult>;
  /** Device-scoped local adb background spawn for `serial`; the host owns stream wiring. */
  spawnSerialAdb(
    serial: string,
    args: string[],
    options?: AndroidAdbSpawnOptions,
  ): AndroidAdbProcess;
  /** Host-global adb execution (no serial), e.g. `adb devices`. */
  execHostAdb(
    args: string[],
    options?: AndroidAdbExecutorOptions,
  ): Promise<AndroidAdbExecutorResult>;
  /** Installs `override` as the host command-executor override for the duration of `fn`. */
  withAdbCommandExecutorOverride<T>(
    override: AndroidAdbCommandExecutorOverride,
    fn: () => Promise<T>,
  ): Promise<T>;
  /** Escapes any active command-executor override for the duration of `fn`. */
  withoutAdbCommandExecutorOverride<T>(fn: () => Promise<T>): Promise<T>;
  /** Normalizes a result that crossed an unchecked SDK/provider boundary. */
  coerceAdbResult<T extends Pick<AndroidAdbExecutorResult, 'stdout' | 'stderr' | 'exitCode'>>(
    result: T,
  ): T;
  /** COMMAND_FAILED details for a non-zero result, flagged for stderr-excerpt enrichment. */
  execFailureDetails(
    result: Pick<AndroidAdbExecutorResult, 'stdout' | 'stderr' | 'exitCode'>,
    extra?: Record<string, unknown>,
  ): Record<string, unknown>;
  emitDiagnostic(event: AndroidAdbDiagnosticEvent): void;
  /** Durable per-state-dir test-IME recovery markers (host-side files). */
  imeRecoveryMarkers: Readonly<{
    write(stateDir: string, serial: string): Promise<boolean>;
    clear(stateDir: string, serial: string): Promise<void>;
    read(stateDir: string): Promise<string[]>;
  }>;
  /** Resolves an npm-bundled helper artifact from the packaged install tree. */
  resolveHelperArtifact<Manifest extends { assetName: string }>(options: {
    helperDirName: string;
    manifestFileName: (version: string) => string;
    parseManifest: (value: unknown) => Manifest;
    unavailableMessage: string;
  }): Promise<{ apkPath: string; manifest: Manifest }>;
  /** Shared helper APK install/version-check/checksum lifecycle. */
  ensureHelperInstalled(
    config: Readonly<{ cache: Set<string>; installTimeoutMs: number; helperLabel: string }>,
    request: Readonly<{
      adb: AndroidAdbExecutor;
      adbProvider: AndroidAdbProvider;
      artifact: AndroidImeHelperArtifact;
      deviceKey: string;
    }>,
  ): Promise<AndroidHelperInstallDecision>;
}>;

let boundHost: AndroidAdbHost | undefined;

/** Composition-time wiring; the last bind wins so test harnesses can rebind. */
export function bindAndroidAdbHost(host: AndroidAdbHost): void {
  boundHost = host;
}

export function requireAndroidAdbHost(): AndroidAdbHost {
  if (!boundHost) {
    throw new Error(
      'Android adb host port is not bound; import the platform composition wiring ' +
        '(src/platforms/android/adb-host-binding.ts) before using the adb/IME cluster.',
    );
  }
  return boundHost;
}

export function emitAndroidAdbDiagnostic(event: AndroidAdbDiagnosticEvent): void {
  requireAndroidAdbHost().emitDiagnostic(event);
}
