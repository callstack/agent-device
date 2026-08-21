import type { MigratedCommandCutover, UnruledViolation } from './runtime-command-cutover-model.ts';
import {
  appStateLegacySessionHandlerViolations,
  applicationLifecycleDurableResourceViolations,
  appLogSessionStateOwnershipViolations,
  closeLifecycleRouteBindingViolations,
  devicesGatewayBindingViolations,
  openLifecycleRouteBindingViolations,
  prepareLifecycleRouteBindingViolations,
  runtimeLifecycleRouteBindingViolations,
  sourceExecutedUsingDeclarationViolations,
} from './runtime-command-cutover-extensions.ts';
import { recordRuntimeDaemonMechanicsViolations } from './record-runtime-mechanics-policy.ts';
import { retiredDispatchProjectionViolations } from './runtime-command-cutover-descriptor.ts';

/**
 * One row per migrated command (ADR 0019 §8). A new command unit adds a row here; the
 * mechanism in `runtime-command-cutover-policy.ts` carries one planted-red proof for
 * every row, and `cutoverRowDefects` rejects a row that leaves its claims unstated.
 *
 * Rule ids are per row: the layering report groups violations under R20 boot, R21 apps,
 * R22 appstate, R23 shutdown, R24-R27 install/deploy, R28-R31 lifecycle, R17 devices,
 * R14 logs, R15 network, and R16 record.
 *
 * A row id is a report heading, so it must be unique across every stack that adds rows here.
 * `cutoverTableDefects` rejects a duplicate; lifecycle starts at R28 after the accepted
 * shutdown, install/deploy, and application-lifecycle allocations. Snapshot starts at R32;
 * diff follows at R33, find at R35, get at R36, is at R37, screenshot at R39, wait at R38,
 * focus at R40, and type at R41 — the Wave 4 observation family is complete.
 */
export const MIGRATED_COMMAND_CUTOVERS: readonly MigratedCommandCutover[] = [
  {
    rule: 'R22 appstate-runtime-cutover',
    command: 'appstate',
    subject: 'foreground app state',
    tier: 'request-scoped',
    execution: 'device-runtime',
    legacyRetirement: {
      daemonOnlyRouteNames: ['getHarmonyAppState'],
    },
    runtimeTypeNames: ['AppStateRuntimeOperations'],
    operations: { names: ['ensureReady', 'appState'] },
    singularExecution: {
      routes: ['handleSessionStateCommands'],
      operations: ['ensureReady', 'appState'],
      operationOwners: {
        ensureReady: ['handleAppStateCommand'],
        appState: ['handleAppStateCommand'],
      },
    },
    extensions: [appStateLegacySessionHandlerViolations],
  },
  {
    rule: 'R20 boot-runtime-cutover',
    command: 'boot',
    subject: 'device readiness',
    tier: 'request-scoped',
    execution: 'device-runtime',
    legacyRetirement: {
      modulePaths: ['src/platform-runtime-device-readiness-host.ts'],
      routeNames: ['ensureAndroidEmulatorBoot', 'resolveAndroidEmulatorAvdName'],
    },
    admissionMember: {
      forms: ['computed-property'],
      files: ['src/platforms/apple/plugin.ts'],
      message: 'Apple plugin retains legacy boot support or hint closure',
    },
    runtimeTypeNames: ['DeviceReadinessRuntimeOperations'],
    operations: { names: ['bootTarget', 'bootTargetHeadless'] },
    singularExecution: {
      routes: ['handleSessionStateCommands'],
      operations: ['bootTarget', 'bootTargetHeadless'],
      operationOwners: {
        bootTarget: ['handleSessionStateCommands'],
        bootTargetHeadless: ['handleSessionStateCommands'],
      },
    },
  },
  {
    rule: 'R21 apps-runtime-cutover',
    command: 'apps',
    subject: 'app inventory',
    tier: 'request-scoped',
    execution: 'device-runtime',
    legacyRetirement: {
      daemonOnlyRouteNames: [
        'listAndroidApps',
        'listIosApps',
        'listHarmonyApps',
        'resolveInstalledAppForDoctor',
      ],
    },
    admissionMember: {
      forms: ['computed-property'],
      files: ['src/platforms/apple/plugin.ts'],
      message: 'Apple plugin retains legacy apps support or hint closure',
    },
    runtimeTypeNames: ['AppInventoryRuntimeOperations'],
    operations: { names: ['ensureReady', 'listApps'] },
    singularExecution: {
      routes: ['handleAppsInventory'],
      operations: ['ensureReady', 'listApps'],
      operationOwners: {
        ensureReady: ['ensureAppsRuntimeReady'],
        listApps: ['listAppsFromRuntime'],
      },
    },
  },
  {
    rule: 'R23 shutdown-runtime-cutover',
    command: 'shutdown',
    subject: 'shutdown',
    tier: 'request-scoped',
    execution: 'device-runtime',
    legacyRetirement: {
      modulePaths: ['src/daemon/target-shutdown.ts'],
      importPatterns: [/(?:^|\/)target-shutdown(?:\.[cm]?[jt]s)?$/],
      routeNames: ['canShutdownDeviceTarget', 'shutdownDeviceTarget'],
    },
    runtimeTypeNames: ['DeviceShutdownRuntimeOperations'],
    operations: { names: ['shutdownTarget'] },
    singularExecution: {
      routes: ['handleSessionStateCommands'],
      operations: ['shutdownTarget'],
      operationOwners: { shutdownTarget: ['handleSessionStateCommands'] },
    },
  },
  {
    rule: 'R24 install-runtime-cutover',
    command: 'install',
    subject: 'app installation',
    tier: 'request-scoped',
    execution: 'device-runtime',
    legacyRetirement: {
      modulePaths: ['src/daemon/handlers/session-deploy.ts'],
      importPatterns: [/(?:^|\/)session-deploy(?:\.[cm]?[jt]s)?$/],
      routeNames: [
        'APP_INSTALL_CAPABILITY',
        'defaultInstallOps',
        'handleAppDeployCommand',
        'installProviderDeviceApp',
      ],
    },
    admissionMember: {
      forms: ['computed-property'],
      files: ['src/platforms/apple/plugin.ts'],
      message: 'Apple plugin retains legacy install support or hint closure',
    },
    runtimeTypeNames: ['AppDeploymentRuntimeOperations'],
    operations: { names: ['deployApp'] },
    singularExecution: {
      routes: ['handleAppDeploymentCommand'],
      operations: ['deployApp'],
      operationOwners: { deployApp: ['handleAppDeploymentCommand'] },
    },
  },
  {
    rule: 'R25 reinstall-runtime-cutover',
    command: 'reinstall',
    subject: 'app reinstallation',
    tier: 'request-scoped',
    execution: 'device-runtime',
    legacyRetirement: {
      modulePaths: ['src/daemon/handlers/session-deploy.ts'],
      importPatterns: [/(?:^|\/)session-deploy(?:\.[cm]?[jt]s)?$/],
      routeNames: [
        'APP_INSTALL_CAPABILITY',
        'defaultReinstallOps',
        'handleAppDeployCommand',
        'installProviderDeviceApp',
      ],
    },
    admissionMember: {
      forms: ['computed-property'],
      files: ['src/platforms/apple/plugin.ts'],
      message: 'Apple plugin retains legacy reinstall support or hint closure',
    },
    runtimeTypeNames: ['AppDeploymentRuntimeOperations'],
    operations: { names: ['deployApp'] },
    singularExecution: {
      routes: ['handleAppDeploymentCommand'],
      operations: ['deployApp'],
      operationOwners: { deployApp: ['handleAppDeploymentCommand'] },
    },
  },
  {
    rule: 'R26 install-source-runtime-cutover',
    command: 'install_source',
    subject: 'source installation',
    tier: 'request-scoped',
    execution: 'device-runtime',
    legacyRetirement: {
      modulePaths: ['src/daemon/handlers/install-source.ts'],
      routeNames: ['handleInstallFromSourceCommand', 'installProviderDeviceInstallablePath'],
    },
    runtimeTypeNames: ['AppDeploymentRuntimeOperations', 'DeviceReadinessRuntimeOperations'],
    operations: { names: ['ensureReady', 'materializeAppSource', 'deployMaterializedApp'] },
    singularExecution: {
      routes: ['handleInstallFromSourceDeploymentCommand'],
      operations: ['ensureReady', 'materializeAppSource', 'deployMaterializedApp'],
      operationOwners: {
        ensureReady: ['handleInstallFromSourceDeploymentCommand'],
        materializeAppSource: ['handleInstallFromSourceDeploymentCommand'],
        deployMaterializedApp: ['handleInstallFromSourceDeploymentCommand'],
      },
    },
  },
  {
    rule: 'R27 push-runtime-cutover',
    command: 'push',
    subject: 'push notification',
    tier: 'request-scoped',
    execution: 'device-runtime',
    legacyRetirement: { routeNames: ['handlePushCommand'] },
    admissionMember: {
      forms: ['computed-property'],
      files: ['src/platforms/apple/plugin.ts'],
      message: 'Apple plugin retains legacy push support or hint closure',
    },
    runtimeTypeNames: ['AppDeploymentRuntimeOperations', 'DeviceReadinessRuntimeOperations'],
    operations: { names: ['ensureReady', 'sendPushNotification'] },
    singularExecution: {
      routes: ['handlePushNotificationCommand'],
      operations: ['ensureReady', 'sendPushNotification'],
      operationOwners: {
        ensureReady: ['handlePushNotificationCommand'],
        sendPushNotification: ['handlePushNotificationCommand'],
      },
    },
  },
  {
    rule: 'R17 device-inventory-cutover',
    command: 'devices',
    subject: 'device inventory',
    tier: 'request-scoped',
    execution: 'inventory',
    legacyRetirement: {
      modulePaths: ['src/core/platform-inventory.ts'],
      modulePathPatterns: [/^src\/platforms\/(?:[^/]+\/)*devices\.ts$/],
      importPatterns: [
        /(?:^|\/)core\/platform-inventory(?:\.[cm]?[jt]s)?$/,
        /(?:^|\/)platforms\/(?:[^/]+\/)*devices(?:\.[cm]?[jt]s)?$/,
      ],
      routeNames: [
        'discoverDevices',
        'listAndroidDevices',
        'listAppleDevices',
        'listHarmonyDevices',
        'listHarmonyOsDevices',
        'listLinuxDevices',
        'listMacosDevices',
        'listVegaDevices',
        'listWebDevices',
      ],
    },
    singularExecution: { gatewayProof: devicesGatewayBindingViolations },
  },
  {
    rule: 'R14 logs-runtime-cutover',
    command: 'logs',
    subject: 'logs',
    tier: 'durable-resource',
    execution: 'device-runtime',
    legacyRetirement: {
      routeNames: [
        'startAppLog',
        'stopAppLog',
        'runAppLogDoctor',
        'resolveLogBackend',
        'withAppLogProvider',
        'appLogProvider',
        'AppLogProviderResolver',
        'AppLogProvider',
      ],
      pluginFacetKeys: ['appLog'],
    },
    // Apple logs admission is a computed property key; `PUBLIC_COMMANDS.logs` as a plain
    // member is not an admission signal for this command.
    admissionMember: {
      forms: ['computed-property'],
      message: 'Apple plugin retains legacy logs support or hint closure',
    },
    runtimeTypeNames: ['AppLogRuntimeOperations', 'AppLogLiveHandle'],
    // Input-dependent plan: the logs use narrows to a family, not a fixed operation list.
    operations: { pattern: /^appLog[A-Za-z]+$/ },
    nonNullRepairScope: 'any-operation',
    // The app-log operation set is input-dependent, so only the daemon route is singular.
    singularExecution: { routes: ['handleLogsCommand'] },
    lifecycleProof: appLogSessionStateOwnershipViolations,
    extensions: [sourceExecutedUsingDeclarationViolations],
  },
  {
    rule: 'R15 network-runtime-cutover',
    command: 'network',
    subject: 'network',
    tier: 'request-scoped',
    execution: 'device-runtime',
    legacyRetirement: {
      modulePaths: [
        'src/daemon/network-log.ts',
        'src/daemon/app-log-network-recovery.ts',
        'src/daemon/network-log-android-recovery.ts',
        'src/daemon/network-log-ios-simulator-recovery.ts',
      ],
      daemonOnlyRouteNames: [
        'handleWebNetworkCommand',
        'readSessionNetworkCapture',
        'readRecentNetworkTraffic',
        'readRecentAndroidLogcatForPackage',
        'readRecentIosSimulatorLogShowForBundle',
      ],
      daemonOnlyProviderMethods: ['dumpNetwork'],
    },
    // Scoped to the Apple plugin: elsewhere `PUBLIC_COMMANDS.network` is an identifier,
    // not an admission decision.
    admissionMember: {
      forms: ['public-commands-member'],
      files: ['src/platforms/apple/plugin.ts'],
      message: 'Apple plugin retains legacy network support or hint closure',
    },
    runtimeTypeNames: ['NetworkRuntimeOperations'],
    operations: { names: ['networkDump'] },
    singularExecution: {
      routes: ['handleNetworkCommand'],
      operations: ['networkDump'],
      operationOwners: { networkDump: ['handleNetworkCommand'] },
    },
  },
  {
    rule: 'R16 record-runtime-cutover',
    command: 'record',
    subject: 'recording',
    tier: 'durable-resource',
    execution: 'device-runtime',
    legacyRetirement: {
      modulePaths: ['src/daemon/recording-provider.ts'],
      importPatterns: [/(?:^|\/)recording-provider(?:\.[cm]?[jt]s)?$/],
      routeNames: [
        'resolveRecordingBackendForDevice',
        'stopActiveRecording',
        'RecordingBackend',
        'RecordingStartBackend',
        'RECORDING_BACKENDS_BY_TAG',
        'RecordingBackendTag',
        'RecordingProvider',
        'RecordingProviderResolver',
        'recordingProvider',
        'resolveRecordingProvider',
        'withRecordingProvider',
        'createLocalRecordingProvider',
      ],
      pluginFacetKeys: ['recording'],
    },
    // No admission-member claim: `PUBLIC_COMMANDS.record` is live identifier-only data in
    // the daemon session-event tables, so the member form cannot discriminate here.
    runtimeTypeNames: ['ScreenRecordingRuntimeOperations', 'ScreenRecordingLiveHandle'],
    operations: {
      names: ['screenRecordingStart', 'screenRecordingReattach', 'screenRecordingCleanup'],
    },
    singularExecution: {
      routes: ['handleRecordTraceCommands'],
      operations: ['screenRecordingStart', 'screenRecordingReattach', 'screenRecordingCleanup'],
      operationOwners: {
        screenRecordingStart: ['startRecording'],
        screenRecordingReattach: ['createScreenRecordingRecoveryControl'],
        screenRecordingCleanup: ['createScreenRecordingRecoveryControl'],
      },
    },
    lifecycleProof: recordDaemonMechanicsProof,
  },
  {
    rule: 'R28 open-runtime-cutover',
    command: 'open',
    subject: 'application opening',
    tier: 'durable-resource',
    execution: 'device-runtime',
    legacyRetirement: {
      modulePaths: ['src/platform-runtime-application-lifecycle-open.ts'],
      importPatterns: [/(?:^|\/)platform-runtime-application-lifecycle-open(?:\.[cm]?[jt]s)?$/],
      routeNames: [
        'createApplicationOpenOperations',
        'dispatchApplicationLifecycleCommand',
        'applicationLifecycleDispatchContext',
        'applicationLifecycleRunnerOptions',
      ],
    },
    runtimeTypeNames: ['ApplicationLifecycleRuntimeOperations'],
    operations: {
      pattern:
        /^(?:resolveOpenTarget|prepareApplicationOpen|openApplication|applyRuntimeHints|clearRuntimeHints)$/,
    },
    singularExecution: { routeProof: openLifecycleRouteBindingViolations },
    lifecycleProof: applicationLifecycleDurableResourceViolations,
  },
  {
    rule: 'R29 prepare-runtime-cutover',
    command: 'prepare',
    subject: 'Apple runner preparation',
    tier: 'durable-resource',
    execution: 'device-runtime',
    legacyRetirement: {
      modulePaths: ['src/platform-runtime-application-lifecycle-host.ts'],
      importPatterns: [/(?:^|\/)platform-runtime-application-lifecycle-host(?:\.[cm]?[jt]s)?$/],
    },
    runtimeTypeNames: ['ApplicationLifecycleRuntimeOperations'],
    operations: { pattern: /^prepareAppleRunner$/ },
    singularExecution: { routeProof: prepareLifecycleRouteBindingViolations },
    lifecycleProof: applicationLifecycleDurableResourceViolations,
  },
  {
    rule: 'R30 close-runtime-cutover',
    command: 'close',
    subject: 'application closing',
    tier: 'durable-resource',
    execution: 'device-runtime',
    legacyRetirement: {
      modulePaths: ['src/platform-runtime-application-lifecycle-close.ts'],
      importPatterns: [/(?:^|\/)platform-runtime-application-lifecycle-close(?:\.[cm]?[jt]s)?$/],
      routeNames: ['dispatchApplicationLifecycleCommand'],
    },
    runtimeTypeNames: ['ApplicationLifecycleRuntimeOperations'],
    operations: { pattern: /^(?:closeApplication|finalizeApplicationClose|clearRuntimeHints)$/ },
    singularExecution: { routeProof: closeLifecycleRouteBindingViolations },
    lifecycleProof: applicationLifecycleDurableResourceViolations,
  },
  {
    rule: 'R31 runtime-runtime-cutover',
    command: 'runtime',
    subject: 'runtime hints and provider port reverse',
    tier: 'durable-resource',
    execution: 'device-runtime',
    legacyRetirement: {
      modulePaths: ['src/platform-runtime-application-lifecycle-ownership.ts'],
      importPatterns: [
        /(?:^|\/)platform-runtime-application-lifecycle-ownership(?:\.[cm]?[jt]s)?$/,
      ],
      routeNames: ['ProviderPortReverse'],
    },
    runtimeTypeNames: ['ApplicationLifecycleRuntimeOperations'],
    operations: { pattern: /^(?:clearRuntimeHints|configureProviderPortReverse)$/ },
    singularExecution: { routeProof: runtimeLifecycleRouteBindingViolations },
    lifecycleProof: applicationLifecycleDurableResourceViolations,
  },
  {
    rule: 'R32 snapshot-runtime-cutover',
    command: 'snapshot',
    subject: 'snapshot capture',
    tier: 'request-scoped',
    execution: 'device-runtime',
    legacyRetirement: {
      routeNames: ['handleSnapshotCommand'],
    },
    runtimeTypeNames: ['SnapshotRuntimeOperations'],
    operations: {
      names: [
        'captureSnapshot',
        'captureSnapshotWithCustomActions',
        'captureSnapshotWithoutActiveApp',
      ],
    },
    singularExecution: {
      routes: ['handleSnapshotCommands'],
      operations: [
        'captureSnapshot',
        'captureSnapshotWithCustomActions',
        'captureSnapshotWithoutActiveApp',
      ],
      operationOwners: {
        captureSnapshot: ['selectActiveAppSnapshot'],
        captureSnapshotWithCustomActions: ['selectCustomActionsSnapshot'],
        captureSnapshotWithoutActiveApp: ['selectSnapshotWithoutActiveApp'],
      },
    },
    extensions: [snapshotRetiredDispatchProjectionProof],
  },
  {
    rule: 'R33 diff-runtime-cutover',
    command: 'diff',
    subject: 'snapshot diff capture',
    tier: 'request-scoped',
    execution: 'device-runtime',
    legacyRetirement: {
      modulePaths: ['src/daemon/snapshot-diff-legacy-admission.ts'],
      importPatterns: [/(?:^|\/)snapshot-diff-legacy-admission(?:\.[cm]?[jt]s)?$/],
      routeNames: ['requireLegacyDiffCustomActionsSupported', 'requireLegacyDiffIosAppSession'],
    },
    runtimeTypeNames: ['SnapshotRuntimeOperations'],
    operations: {
      names: [
        'captureSnapshot',
        'captureSnapshotWithCustomActions',
        'captureSnapshotWithoutActiveApp',
      ],
    },
    singularExecution: {
      routes: ['handleSnapshotCommands'],
      operations: [
        'captureSnapshot',
        'captureSnapshotWithCustomActions',
        'captureSnapshotWithoutActiveApp',
      ],
      operationOwners: {
        captureSnapshot: ['selectActiveAppSnapshot'],
        captureSnapshotWithCustomActions: ['selectCustomActionsSnapshot'],
        captureSnapshotWithoutActiveApp: ['selectSnapshotWithoutActiveApp'],
      },
    },
    extensions: [diffRetiredDispatchProjectionProof],
  },
  {
    rule: 'R35 find-runtime-cutover',
    command: 'find',
    subject: 'find target resolution',
    tier: 'request-scoped',
    execution: 'device-runtime',
    legacyRetirement: {
      // The whole retirement is admission data: the capability bucket plus the two overlay set
      // memberships. Every route name survived — what changed is that the mutating target
      // capture now enters resolveBoundSelectorCapture like every selector read, which is why
      // the shared owners below carry find's captures too.
      staticCommandSets: ['HARMONYOS_SUPPORTED_COMMANDS', 'WEB_QUERY_COMMANDS'],
    },
    runtimeTypeNames: ['SnapshotRuntimeOperations', 'ElementTextRuntimeOperations'],
    operations: {
      names: ['captureSnapshot', 'captureSnapshotWithoutActiveApp', 'readTextAtPoint'],
    },
    singularExecution: {
      routes: ['handleFindCommands'],
      operations: ['captureSnapshot', 'captureSnapshotWithoutActiveApp', 'readTextAtPoint'],
      // Find shares every owner with `get`: its captures enter the same admit-then-bind
      // selectors and its read-only get-text leg consumes the same preferred read owner.
      operationOwners: {
        captureSnapshot: ['selectActiveAppSnapshot'],
        captureSnapshotWithoutActiveApp: ['selectSnapshotWithoutActiveApp'],
        readTextAtPoint: ['selectElementTextOperation'],
      },
    },
  },
  {
    rule: 'R36 get-runtime-cutover',
    command: 'get',
    subject: 'element read',
    tier: 'request-scoped',
    execution: 'device-runtime',
    // Two retirements. `get`'s own legacy admission was its capability bucket plus the static
    // family command sets the matrix augments it with — the row's automatic admission columns
    // reject the bucket and the `requireCommandSupported('get', …)` call. And the shared element
    // read: both consumers of the selector backend's read (`get text` and read-only
    // `find … get text`) now execute the bound `readTextAtPoint`, so the legacy `read` dispatch
    // alias retires whole. Deleting its registry entry drops `'read'` from
    // `DescriptorDispatchCommandName`, which makes a surviving `DISPATCH_HANDLERS.read` a COMPILE
    // error rather than something this row has to police.
    legacyRetirement: {
      modulePaths: ['src/daemon/handlers/interaction-read-legacy-dispatch.ts'],
      importPatterns: [/(?:^|\/)handlers\/interaction-read-legacy-dispatch(?:\.[cm]?[jt]s)?$/],
      // `dispatchDirectIosSelectorGet` was `get`'s last route to the platform outside the seam:
      // it reached `runAppleRunnerCommand` through a path this row declares no operation for.
      // Admitting before a bypass is not executing through the seam, so the bypass is retired
      // rather than ordered after admission. `queryDirectIosSelector` itself stays — the Wave 5
      // offscreen-target probe still consumes it and it remains single-copy.
      routeNames: ['handleReadCommand', 'dispatchDirectIosSelectorGet'],
    },
    runtimeTypeNames: ['ElementTextRuntimeOperations', 'SnapshotRuntimeOperations'],
    operations: {
      names: ['captureSnapshot', 'captureSnapshotWithoutActiveApp', 'readTextAtPoint'],
    },
    singularExecution: {
      routes: ['dispatchGetViaRuntime'],
      operations: ['captureSnapshot', 'captureSnapshotWithoutActiveApp', 'readTextAtPoint'],
      // `get` executes through the shared selector seam, so the capture owners are the SAME
      // selectors `snapshot`/`diff` count; only the preferred element read is this unit's own.
      // With the direct-iOS bypass retired these names are now the ONLY routes from
      // `dispatchGetViaRuntime` to the platform, so the claim states what the code does.
      operationOwners: {
        captureSnapshot: ['selectActiveAppSnapshot'],
        captureSnapshotWithoutActiveApp: ['selectSnapshotWithoutActiveApp'],
        readTextAtPoint: ['selectElementTextOperation'],
      },
    },
  },
  {
    rule: 'R37 is-runtime-cutover',
    command: 'is',
    subject: 'element predicate',
    tier: 'request-scoped',
    execution: 'device-runtime',
    // `is` retired no module, route, or dispatch projection — it had none. Its whole legacy
    // admission was the capability bucket (rejected by this row's automatic descriptor column)
    // plus membership in these two static sets, which is a DATA deletion. Naming the sets proves
    // it from both sides: each must still be declared in production source and must no longer
    // list `is`, so neither an invented name nor a skipped deletion can satisfy it.
    legacyRetirement: {
      staticCommandSets: ['HARMONYOS_SUPPORTED_COMMANDS', 'WEB_QUERY_COMMANDS'],
    },
    runtimeTypeNames: ['SnapshotRuntimeOperations'],
    operations: { names: ['captureSnapshot', 'captureSnapshotWithoutActiveApp'] },
    singularExecution: {
      routes: ['dispatchIsViaRuntime'],
      operations: ['captureSnapshot', 'captureSnapshotWithoutActiveApp'],
      // `is` executes through the shared selector seam, so its capture owners are the SAME
      // selectors `snapshot`/`diff`/`get` count. It declares no operation of its own: every
      // predicate answers from the resolved tree, so `readTextAtPoint` stays R36's alone.
      //
      // Scope, stated so this is not read as absolute: the claim covers how a predicate is
      // EXECUTED. Since the direct-iOS selector shortcut retired, the bound capture is the only
      // thing that answers one. It does NOT claim the route makes no other device call — the
      // Android foreground-blocker diagnostic still reaches adb through
      // `platforms/android/app-lifecycle.ts`, on the FAILURE path only, where it can enrich an
      // already-failed response's message but can never produce or change a verdict. That edge
      // is pre-existing, co-owned with `wait`, and recorded as Wave 6 denominator work; R22's
      // `appState` is its declared replacement.
      operationOwners: {
        captureSnapshot: ['selectActiveAppSnapshot'],
        captureSnapshotWithoutActiveApp: ['selectSnapshotWithoutActiveApp'],
      },
    },
  },
  {
    rule: 'R40 focus-runtime-cutover',
    command: 'focus',
    subject: 'point focus',
    tier: 'request-scoped',
    execution: 'device-runtime',
    legacyRetirement: {
      // The interactor leaf and its dispatch-table arm. `find`'s focus leg keeps its helper
      // name — what changed is what it calls: the same `resolveBoundFocusRuntime` the generic
      // route binds, which is why `focusPoint` still has exactly one owner below.
      routeNames: ['handleFocusCommand'],
      // `focus` also leaves the two hand-maintained overlays that granted it a capability
      // bucket on families the descriptor never listed.
      staticCommandSets: ['HARMONYOS_SUPPORTED_COMMANDS', 'WEB_INTERACTION_COMMANDS'],
    },
    runtimeTypeNames: ['FocusRuntimeOperations'],
    operations: { names: ['focusPoint'] },
    singularExecution: {
      routes: ['dispatchGenericCommand'],
      operations: ['focusPoint'],
      // The call moved into the shared executor when find's R35 single bind began passing its
      // own operations through it; one lexical owner still serves both consumers.
      operationOwners: { focusPoint: ['executeFocusPoint'] },
    },
  },
  {
    rule: 'R41 type-runtime-cutover',
    command: 'type',
    subject: 'text entry',
    tier: 'request-scoped',
    execution: 'device-runtime',
    legacyRetirement: {
      // The interactor leaf and its dispatch-table arm. The interaction backend's `typeText`
      // member and find's type leg keep their names — what changed is what they call: the same
      // `resolveBoundTypeTextRuntime`, which is why `typeText` has exactly one owner below.
      routeNames: ['handleTypeCommand', 'typeTextCommand'],
      // `type` also leaves the two hand-maintained overlays that granted it a capability
      // bucket on families the descriptor never listed.
      staticCommandSets: ['HARMONYOS_SUPPORTED_COMMANDS', 'WEB_INTERACTION_COMMANDS'],
    },
    runtimeTypeNames: ['TypeTextRuntimeOperations'],
    operations: { names: ['typeText'] },
    singularExecution: {
      routes: ['handleInteractionCommands'],
      operations: ['typeText'],
      operationOwners: { typeText: ['executeBoundTypeText'] },
    },
  },
  {
    rule: 'R34 viewport-runtime-cutover',
    command: 'viewport',
    subject: 'web viewport resize',
    tier: 'request-scoped',
    execution: 'device-runtime',
    legacyRetirement: {
      routeNames: ['handleViewportCommand'],
    },
    runtimeTypeNames: ['ViewportRuntimeOperations'],
    operations: { names: ['setViewport'] },
    singularExecution: {
      routes: ['dispatchGenericCommand'],
      operations: ['setViewport'],
      operationOwners: { setViewport: ['resolveBoundViewportRuntime'] },
    },
  },
  {
    rule: 'R39 screenshot-runtime-cutover',
    command: 'screenshot',
    subject: 'screen capture',
    tier: 'request-scoped',
    execution: 'device-runtime',
    legacyRetirement: {
      // The command leaf, the daemon adapter that re-entered it, and the evidence capture that
      // dispatched it directly. `captureSnapshot` is shared with the snapshot unit and stays.
      routeNames: [
        'handleScreenshotCommand',
        'dispatchScreenshotViaRuntime',
        'executeScreenshotPlatformCommand',
        'resolveScreenshotOutputPlacement',
      ],
    },
    runtimeTypeNames: ['ScreenshotRuntimeOperations'],
    operations: { names: ['captureScreenshot'] },
    singularExecution: {
      routes: ['dispatchGenericCommand'],
      operations: ['captureScreenshot'],
      operationOwners: { captureScreenshot: ['selectScreenshotCapture'] },
    },
  },
  {
    rule: 'R38 wait-runtime-cutover',
    command: 'wait',
    subject: 'wait polling capture',
    tier: 'request-scoped',
    execution: 'device-runtime',
    legacyRetirement: {
      // The direct iOS selector probe wait took before polling, and the daemon-side Apple
      // plumbing that used to answer `findText` by selecting on family and provider. The
      // reading itself did not go away — it moved behind the owner's declared `findText`
      // operation — but nothing in the daemon may reach the runner for it again.
      routeNames: [
        'dispatchDirectIosSelectorWait',
        'findTextWithAppleRunner',
        'findTextInMacosNonAppSurface',
        'readAppleRunnerFindTextTarget',
        'buildAppleRunnerFindTextOptions',
        'captureWaitSnapshot',
        'AppleRunnerFindTextTarget',
      ],
    },
    runtimeTypeNames: [
      'SnapshotRuntimeOperations',
      'FindTextRuntimeOperations',
      'FindSelectorRuntimeOperations',
    ],
    operations: {
      names: ['captureSnapshot', 'captureSnapshotWithoutActiveApp', 'findText', 'findSelector'],
    },
    singularExecution: {
      routes: ['handleSnapshotCommands'],
      operations: [
        'captureSnapshot',
        'captureSnapshotWithoutActiveApp',
        'findText',
        'findSelector',
      ],
      // The selector family's shared owners: wait binds through the same admit-then-bind entry
      // as find/get/is, so it introduces no parallel binder for either operation.
      operationOwners: {
        captureSnapshot: ['selectActiveAppSnapshot'],
        captureSnapshotWithoutActiveApp: ['selectSnapshotWithoutActiveApp'],
        findText: ['selectWaitObservationOperations'],
        findSelector: ['selectWaitObservationOperations'],
      },
    },
  },
];

function snapshotRetiredDispatchProjectionProof(
  sources: ReadonlyMap<string, string>,
): UnruledViolation[] {
  return retiredDispatchProjectionViolations(sources, 'snapshot');
}

function diffRetiredDispatchProjectionProof(
  sources: ReadonlyMap<string, string>,
): UnruledViolation[] {
  return retiredDispatchProjectionViolations(sources, 'diff');
}

/** The record mechanics policy predates the row model and reports `path: message`. */
function recordDaemonMechanicsProof(sources: ReadonlyMap<string, string>): UnruledViolation[] {
  const production = [...sources].map(([path, source]) => ({ path, source }));
  return recordRuntimeDaemonMechanicsViolations(production).map((violation) => {
    const separator = violation.indexOf(': ');
    return {
      file: separator < 0 ? '(record runtime)' : violation.slice(0, separator),
      line: 1,
      message: separator < 0 ? violation : violation.slice(separator + 2),
    };
  });
}
