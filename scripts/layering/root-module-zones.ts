/**
 * The zone of every process-root module (`src/<name>.ts`).
 *
 * A folder names the zone of every file under it; a root module has no folder, so its zone is
 * declared here and `targetDagZone` reads it. `(root)` ranks above every other zone, so it holds
 * only the executables: any ranked module importing a `(root)` member is a spine back-edge (R5).
 * Every root module is declared, so none can sit outside the ranked spine unnoticed.
 *
 * This reduces `(root)` in the logical graph only: the declared modules still live directly under
 * `src/`, and classifying them is not collocating them. The table bridges that layout and should
 * shrink. When a group moves into a folder named for its zone (`src/command-runtime/`,
 * `src/daemon-contracts/`, ...) or into a package, `topFolder` derives the same zone and the
 * group's rows are deleted. The end state: renaming a module within its owner needs no edit here,
 * while a forbidden dependency still fails R5 or R80.
 *
 * Zone membership is a layering fact only. Rules keyed on physical paths — R2's `topFolder`
 * zones, R13's composition files, R76's daemon-to-root inventory, R78's `src/daemon-client/**`
 * scope — keep reading the path, not this declaration.
 */
export const ROOT_MODULE_ZONES: Readonly<Record<string, readonly string[]>> = {
  '(root)': ['src/bin.ts', 'src/cli.ts', 'src/daemon.ts'],
  // Imported by core's interactor resolution, so they sit at core's rank.
  core: ['src/platform-runtime-android-adb-host.ts', 'src/provider-device-runtime.ts'],
  // On-disk and wire contracts a daemon process shares with its clients (#2559): the client
  // reaches the daemon over the network, so both sides read these from below.
  'daemon-contracts': [
    'src/daemon-diagnostics-scope.ts',
    'src/daemon-owner-cleanup.ts',
    'src/daemon-policy-file.ts',
    'src/daemon-process.ts',
    'src/daemon-registration-owner.ts',
    'src/daemon-registration.ts',
    'src/daemon-resolution.ts',
    'src/daemon-shutdown-report.ts',
    'src/request-progress-protocol.ts',
    'src/session-repair-tombstone.ts',
  ],
  // The in-process command runtime: the backend and artifact contracts it drives and the
  // assemblies that bind command families onto it. The daemon executes commands through it.
  'command-runtime': [
    'src/backend-snapshot-options.ts',
    'src/backend.ts',
    'src/io.ts',
    'src/runtime-command-surface.ts',
    'src/runtime-contract.ts',
    'src/runtime-factory.ts',
    'src/runtime.ts',
  ],
  // The platform composition the daemon, CLI and SDK import eagerly. It shares the zone with its
  // private `src/platform-runtime/` submodule.
  'platform-runtime': [
    'src/managed-device-reachability.ts',
    'src/platform-runtime-android-mechanics.ts',
    'src/platform-runtime-android-observation-host.ts',
    'src/platform-runtime-apple-resources.ts',
    'src/platform-runtime-apple-runner-owner.ts',
    'src/platform-runtime-daemon-lifecycle.ts',
    'src/platform-runtime-daemon-owner-cleanup.ts',
    'src/platform-runtime-device-boot.ts',
    'src/platform-runtime-device-inventory.ts',
    'src/platform-runtime-device-ready.ts',
    'src/platform-runtime-gateway.fixtures.ts',
    'src/platform-runtime-gateway.ts',
    'src/platform-runtime-host-diagnostics.ts',
    'src/platform-runtime-managed-web-backend.ts',
    'src/platform-runtime-open-target.ts',
    'src/platform-runtime-resource-cleanup.ts',
    'src/platform-runtime.ts',
    'src/provider-credential-fingerprint.ts',
    'src/provider-device-runtimes.ts',
    'src/provider-limrun-credentials.ts',
    'src/provider-webdriver.ts',
  ],
  // The operation host the platform runtime loads through `import()` (`loadHost`) and its facets.
  // It ranks above every spine zone, so a static import of it is a back-edge from anywhere but
  // `(root)`; some facets read daemon session artifacts, so it can never rank below daemon-server.
  'platform-runtime-host': [
    'src/platform-runtime-android-application-tools.ts',
    'src/platform-runtime-android-deployment-executor.ts',
    'src/platform-runtime-android-emulator-host.ts',
    'src/platform-runtime-android-tool-host.ts',
    'src/platform-runtime-app-log-android-transport.ts',
    'src/platform-runtime-app-log-output.ts',
    'src/platform-runtime-app-log-process.ts',
    'src/platform-runtime-apple-application-tools.ts',
    'src/platform-runtime-apple-automation-keep-hot.ts',
    'src/platform-runtime-apple-deployment-executor.ts',
    'src/platform-runtime-apple-physical-readiness.ts',
    'src/platform-runtime-apple-tool-host.ts',
    'src/platform-runtime-application-resources.ts',
    'src/platform-runtime-audio-probe-host.ts',
    'src/platform-runtime-device-shutdown-host.ts',
    'src/platform-runtime-host-device-shell.ts',
    'src/platform-runtime-host.ts',
    'src/platform-runtime-local-application-interactors.ts',
    'src/platform-runtime-managed-owner.ts',
    'src/platform-runtime-network-host.ts',
    'src/platform-runtime-network-web-transport.ts',
    'src/platform-runtime-operation-host.ts',
    'src/platform-runtime-perf-capture-host.ts',
    'src/platform-runtime-perf-host.ts',
    'src/platform-runtime-runtime-hints.ts',
    'src/platform-runtime-screen-recording-android-host.ts',
    'src/platform-runtime-screen-recording-apple-host.ts',
    'src/platform-runtime-screen-recording-apple-runner-host.ts',
    'src/platform-runtime-screen-recording-apple-runner-transport.ts',
    'src/platform-runtime-screen-recording-apple-simulator-host.ts',
    'src/platform-runtime-screen-recording-apple-transport.ts',
    'src/platform-runtime-screen-recording-finalizer-host.ts',
    'src/platform-runtime-screen-recording-harmony-host.ts',
    'src/platform-runtime-screen-recording-host.ts',
    'src/platform-runtime-screen-recording-output-host.ts',
    'src/platform-runtime-screen-recording-process-host.ts',
    'src/platform-runtime-screen-recording-web-host.ts',
    'src/platform-runtime-toolchain-host.ts',
  ],
  // The typed client over the daemon transport.
  'daemon-client': ['src/agent-device-client.ts'],
  sdk: ['src/finders.ts', 'src/provider-limrun-runtime.ts'],
};

const ZONE_BY_ROOT_MODULE: ReadonlyMap<string, string> = new Map(
  Object.entries(ROOT_MODULE_ZONES).flatMap(([zone, modules]) =>
    modules.map((module) => [module, zone] as const),
  ),
);

/** Whether `file` is a process-root module: a `.ts` file directly under `src/`. */
export function isRootModule(file: string): boolean {
  return /^src\/[^/]+\.ts$/.test(file);
}

/** The declared zone of a root module, or `undefined` when the module is not declared. */
export function declaredRootModuleZone(file: string): string | undefined {
  return ZONE_BY_ROOT_MODULE.get(file);
}

/**
 * Root modules in `files` with no declared zone, declared modules that are not in `files`, and
 * modules declared in more than one zone. All empty means the declaration describes the tree.
 */
export function rootModuleZoneDrift(files: readonly string[]): {
  undeclared: string[];
  stale: string[];
  duplicated: string[];
} {
  const present = new Set(files.filter(isRootModule));
  const declared = Object.values(ROOT_MODULE_ZONES).flat();
  return {
    undeclared: [...present].filter((file) => !ZONE_BY_ROOT_MODULE.has(file)).sort(),
    stale: [...ZONE_BY_ROOT_MODULE.keys()].filter((file) => !present.has(file)).sort(),
    duplicated: [...new Set(declared.filter((file, index) => declared.indexOf(file) !== index))],
  };
}
