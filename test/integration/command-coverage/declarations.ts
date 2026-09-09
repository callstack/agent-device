import { PUBLIC_COMMANDS } from '@agent-device/command-registry/catalog';
import { ANDROID_AUDIO_CONTRACT_EVIDENCE } from '../../../src/daemon/session-observability/__tests__/session-audio.coverage.ts';
import { ANDROID_INSTALL_SOURCE_CONTRACT_EVIDENCE } from '../../../src/__tests__/install-source.coverage.ts';
import { ANDROID_LIFECYCLE_CONTRACT_EVIDENCE } from '../provider-scenarios/android-lifecycle.coverage.ts';
import {
  androidEmulator,
  iosSimulator,
  linux,
  macos,
  tvos,
  web,
  type CommandCoverageDeclaration,
  type CoveragePlatform,
  type PublicCommand,
} from './entries.ts';
import {
  ANDROID_APPLICATION_LIFECYCLE_CONTRACT_EVIDENCE,
  ANDROID_HOVER_RUNTIME_CONTRACT_EVIDENCE,
  ANDROID_TV_REMOTE_RUNTIME_CONTRACT_EVIDENCE,
  ANDROID_VIEWPORT_RUNTIME_CONTRACT_EVIDENCE,
  LINUX_PROVIDER_EVIDENCE,
  LINUX_RUNTIME_EVIDENCE,
  TVOS_AUDIO_EVIDENCE,
  TVOS_REMOTE_EVIDENCE,
} from './evidence.ts';

const C = PUBLIC_COMMANDS;

/**
 * Every public command's coverage judgment on all six platforms that classify the catalog.
 *
 * One row per command, six authored fields. No field is derived from another: a command that is
 * live on Android and a known gap on tvOS says so twice, in its own vocabulary each time. The
 * per-platform `Record<PublicCommand, …>` each e2e runner reads is projected from this table at
 * load time (`projectCoverage`), so adding a public command is one edit here rather than six
 * parallel edits in six manifests.
 *
 * `satisfies Record<PublicCommand, CommandCoverageDeclaration>` is the exhaustiveness check:
 * a command added to the catalog without a row here fails type-checking, and each platform's
 * coverage smoke test fails the same omission at runtime.
 */
const COMMAND_COVERAGE_DECLARATIONS = {
  [C.artifacts]: {
    androidEmulator: androidEmulator.live(
      'full:observability-artifacts',
      'inventory exposes generated recording and trace artifacts and one download consumes its entry',
    ),
    iosSimulator: iosSimulator.contract(
      'src/daemon/__tests__/http-server-artifacts.test.ts',
      'daemon artifact inventory lists artifacts and downloads consume them',
      'daemon inventory exposes a typed non-empty artifact and its downloadable bytes',
    ),
    macos: macos.contract(
      'src/daemon/__tests__/http-server-artifacts.test.ts',
      'daemon artifact inventory lists artifacts and downloads consume them',
      'daemon artifact inventory exposes downloadable files for the macOS session tooling',
    ),
    tvos: tvos.gap('No tvOS-specific artifact inventory command evidence exists yet'),
    web: web.contract(
      'src/daemon/__tests__/request-router-artifacts-web.test.ts',
      'artifacts lists a daemon-tracked artifact produced during a web session',
      'daemon artifact listing round-trips a tracked artifact for a web-backed session',
    ),
    linux: linux.gap(
      'No Linux live command creates a downloadable daemon artifact for inventory yet',
    ),
  },
  [C.devices]: {
    androidEmulator: androidEmulator.live(
      'smoke:inventory',
      'selected emulator serial appears in inventory',
    ),
    iosSimulator: iosSimulator.live(
      'smoke:inventory-install',
      'selected simulator UDID appears in inventory',
    ),
    macos: macos.contract(
      'packages/platform-apple/src/inventory.test.ts',
      'Apple inventory projects the host Mac without loading native tools',
      'Apple inventory projects the local macOS host as a desktop device',
    ),
    tvos: tvos.contract(
      'packages/platform-apple/src/simulator-inventory.test.ts',
      'simctl parser keeps available supported runtimes and their target semantics',
      'tvOS simulator inventory preserves the tv target and tvOS Apple-OS identity',
    ),
    web: web.contract(
      'test/integration/provider-scenarios/web-desktop.test.ts',
      'Provider-backed integration web desktop flow uses semantic web provider calls',
      'web inventory returns the established browser target',
    ),
    linux: linux.contract(
      LINUX_PROVIDER_EVIDENCE.path,
      LINUX_PROVIDER_EVIDENCE.test,
      'Linux provider scenario inventories the selected desktop device through the daemon client',
    ),
  },
  [C.capabilities]: {
    androidEmulator: androidEmulator.live(
      'smoke:inventory',
      'typed capability response includes fixture-driving Android commands',
    ),
    iosSimulator: iosSimulator.live(
      'smoke:inventory-install',
      'typed capability response includes fixture-driving commands',
    ),
    macos: macos.contract(
      'src/daemon/session-lifecycle/internal/__tests__/session-capabilities.test.ts',
      'capabilities preserves session-owned appstate for an active %s session',
      'the capabilities response projects exact runtime facts plus active macOS session state',
    ),
    tvos: tvos.gap('No tvOS-specific capabilities command evidence exists yet'),
    web: web.contract(
      'src/daemon/session-lifecycle/internal/__tests__/session-capabilities.test.ts',
      'capabilities omits apps when $label runtime facts deny the operation',
      'web capability projection reflects runtime-owned unsupported operations',
    ),
    linux: linux.commandEvidenceLive(
      'the command-evidence lane reads capabilities for the selected Linux desktop',
    ),
  },
  [C.doctor]: {
    androidEmulator: androidEmulator.live(
      'smoke:inventory',
      'doctor discovers the installed fixture package',
    ),
    iosSimulator: iosSimulator.live(
      'smoke:inventory-install',
      'doctor discovers the installed fixture app',
    ),
    macos: macos.gap('No command-specific macOS doctor evidence exists yet'),
    tvos: tvos.gap('No tvOS-specific doctor command evidence exists yet'),
    web: web.contract(
      'packages/platform-web/src/__tests__/doctor.test.ts',
      'web doctor lifecycle check reports live managed Chrome process count',
      'web doctor reports managed browser lifecycle evidence',
    ),
    linux: linux.commandEvidenceLive('the command-evidence lane reads Linux doctor diagnostics'),
  },
  [C.apps]: {
    androidEmulator: androidEmulator.live(
      'smoke:inventory',
      'installed fixture package appears in app inventory',
    ),
    iosSimulator: iosSimulator.live(
      'smoke:inventory-install',
      'installed fixture bundle appears in app inventory',
    ),
    macos: macos.live(
      'provider:macos-desktop',
      'provider-backed app inventory lists macOS applications',
    ),
    tvos: tvos.gap('No tvOS-specific app inventory command evidence exists yet'),
    web: web.contract(
      'src/daemon/session-lifecycle/internal/__tests__/session-capabilities.test.ts',
      'capabilities omits apps when $label runtime facts deny the operation',
      'web runtime facts keep native app inventory unavailable',
    ),
    linux: linux.contract(
      LINUX_RUNTIME_EVIDENCE.path,
      LINUX_RUNTIME_EVIDENCE.test,
      'Linux runtime facts explicitly report native app inventory unavailable',
    ),
  },
  [C.boot]: {
    androidEmulator: androidEmulator.contract(
      ANDROID_LIFECYCLE_CONTRACT_EVIDENCE,
      'provider scenario asserts typed Android boot result',
    ),
    iosSimulator: iosSimulator.live(
      'full:device-lifecycle',
      'shutdown simulator boots again and inventory confirms it',
    ),
    macos: macos.contract(
      'src/daemon/handlers/__tests__/session-boot-shutdown.test.ts',
      'boot rejects the macOS host boot cell after one facts inspection and before binding',
      'macOS boot is refused by the runtime fact before dispatch',
    ),
    tvos: tvos.gap('No tvOS-specific boot command evidence exists yet'),
    web: web.contract(
      'packages/platform-web/src/runtime.test.ts',
      'boot and shutdown report the runtime-owned unavailable readiness fact',
      'the web runtime fact rejects device boot',
    ),
    linux: linux.contract(
      LINUX_RUNTIME_EVIDENCE.path,
      LINUX_RUNTIME_EVIDENCE.test,
      'Linux runtime facts explicitly report boot unavailable for the desktop owner',
    ),
  },
  [C.shutdown]: {
    androidEmulator: androidEmulator.contract(
      ANDROID_LIFECYCLE_CONTRACT_EVIDENCE,
      'provider scenario asserts typed Android shutdown result',
    ),
    iosSimulator: iosSimulator.live(
      'full:device-lifecycle',
      'shutdown succeeds and inventory reports the selected simulator stopped',
    ),
    macos: macos.gap('No command-specific macOS shutdown evidence exists yet'),
    tvos: tvos.gap('No tvOS-specific shutdown command evidence exists yet'),
    web: web.contract(
      'packages/platform-web/src/runtime.test.ts',
      'boot and shutdown report the runtime-owned unavailable readiness fact',
      'the web runtime fact rejects device shutdown',
    ),
    linux: linux.gap('No Linux-specific shutdown command evidence exists yet'),
  },
  [C.appState]: {
    androidEmulator: androidEmulator.live(
      'smoke:automation-system',
      'Android foreground package changes on Home and returns to the fixture after restoration',
    ),
    iosSimulator: iosSimulator.live(
      'full:lifecycle-system',
      'session-backed state names the fixture bundle and selected simulator',
    ),
    macos: macos.live('replay:system-settings', 'the System Settings replay reads macOS app state'),
    tvos: tvos.gap('No tvOS-specific app-state command evidence exists yet'),
    web: web.contract(
      'packages/platform-web/src/runtime.test.ts',
      'preserves a narrow web provider dump including empty successful entries',
      'web runtime facts keep app state unavailable',
    ),
    linux: linux.contract(
      LINUX_RUNTIME_EVIDENCE.path,
      LINUX_RUNTIME_EVIDENCE.test,
      'Linux runtime facts explicitly report app state unavailable',
    ),
  },
  [C.perf]: {
    androidEmulator: androidEmulator.live(
      'full:observability-artifacts',
      'startup, process memory, and CPU metrics are typed and numeric on the emulator',
    ),
    iosSimulator: iosSimulator.live(
      'full:observability-artifacts',
      'startup duration, resident memory, and CPU usage are typed and numeric',
    ),
    macos: macos.contract(
      'packages/platform-apple/src/runtime.test.ts',
      'classifies the %s leaf explicitly',
      'macOS performance operations are admitted from runtime facts and expose lazy closures',
    ),
    tvos: tvos.gap('No tvOS-specific performance command evidence exists yet'),
    web: web.contract(
      'packages/platform-web/src/runtime.test.ts',
      'preserves a narrow web provider dump including empty successful entries',
      'web runtime facts explicitly report native performance operations unavailable',
    ),
    linux: linux.contract(
      LINUX_RUNTIME_EVIDENCE.path,
      LINUX_RUNTIME_EVIDENCE.test,
      'Linux runtime facts explicitly report native performance operations unavailable',
    ),
  },
  [C.logs]: {
    androidEmulator: androidEmulator.live(
      'full:observability-artifacts',
      'Android logcat starts, exposes a concrete path, and stops cleanly',
    ),
    iosSimulator: iosSimulator.live(
      'full:observability-artifacts',
      'iOS simulator stream starts, exposes its concrete app.log path, and stops',
    ),
    macos: macos.live(
      'provider:macos-desktop',
      'the provider scenario returns the macOS app log path',
    ),
    tvos: tvos.gap('No tvOS-specific app-log command evidence exists yet'),
    web: web.contract(
      'packages/platform-web/src/runtime.test.ts',
      'logs reports the runtime-owned unavailable app-log facts',
      'the web runtime fact rejects native app-log commands',
    ),
    linux: linux.gap('No Linux-specific app-log command evidence exists yet'),
  },
  [C.events]: {
    androidEmulator: androidEmulator.live(
      'full:observability-artifacts',
      'paged timeline includes commands from the active Android fixture session',
    ),
    iosSimulator: iosSimulator.live(
      'full:observability-artifacts',
      'timeline contains commands from this session',
    ),
    macos: macos.gap('No command-specific macOS event timeline evidence exists yet'),
    tvos: tvos.gap('No tvOS-specific session-event command evidence exists yet'),
    web: web.contract(
      'src/daemon/__tests__/request-router-events.test.ts',
      'events reads the daemon-owned session timeline for a web-backed session',
      'the session-owned event timeline works the same for a web-backed session as any other platform',
    ),
    linux: linux.commandEvidenceLive(
      'the command-evidence lane reads the event timeline produced by its Linux session',
    ),
  },
  [C.network]: {
    androidEmulator: androidEmulator.contract(
      ANDROID_LIFECYCLE_CONTRACT_EVIDENCE,
      'provider scenario returns typed Android network entries',
    ),
    iosSimulator: iosSimulator.contract(
      'packages/platform-apple/src/network/runtime.test.ts',
      'recovers an empty iOS simulator dump from bounded simctl log history',
      'iOS simulator recovery parses HTTP status, duration, and URL from bounded logs',
    ),
    macos: macos.contract(
      'packages/platform-apple/src/network/runtime.test.ts',
      'parses macOS session app-log traffic without loading simulator recovery',
      'macOS network capture parses HTTP traffic from the session app log',
    ),
    tvos: tvos.gap('No tvOS-specific network command evidence exists yet'),
    web: web.live('network dump returns the fixture GET request and requested headers'),
    linux: linux.contract(
      LINUX_RUNTIME_EVIDENCE.path,
      LINUX_RUNTIME_EVIDENCE.test,
      'Linux runtime facts explicitly report network capture unavailable',
    ),
  },
  [C.audio]: {
    androidEmulator: androidEmulator.contract(
      ANDROID_AUDIO_CONTRACT_EVIDENCE,
      'host audio probing has an Android-emulator session contract',
    ),
    iosSimulator: iosSimulator.contract(
      'src/daemon/session-observability/internal/__tests__/session-audio.test.ts',
      'audio probe starts host helper for iOS simulator audio',
      'host audio permission and probe lifecycle; ScreenCaptureKit is not available on hosted CI',
    ),
    macos: macos.contract(
      'src/daemon/session-observability/internal/__tests__/session-audio.test.ts',
      'audio probe start binds once, adopts the durable handle, and answers from it',
      'macOS audio probe starts the ScreenCaptureKit helper and reports its backend',
    ),
    tvos: tvos.contract(
      TVOS_AUDIO_EVIDENCE.path,
      TVOS_AUDIO_EVIDENCE.test,
      'tvOS audio admission follows the host-dependent ScreenCaptureKit capability oracle',
      'host-dependent',
    ),
    web: web.contract(
      'src/daemon/session-observability/internal/__tests__/session-audio.test.ts',
      'audio probe forwards daemon millisecond timing to the web query operation',
      'web audio probe forwards typed duration and bucket values',
    ),
    linux: linux.contract(
      LINUX_RUNTIME_EVIDENCE.path,
      LINUX_RUNTIME_EVIDENCE.test,
      'Linux runtime facts explicitly report audio probing unavailable',
    ),
  },
  [C.replay]: {
    androidEmulator: androidEmulator.live(
      'full:fixture-replays',
      'the catalog traversal fixture runs through replay without retrying its deterministic flow',
    ),
    iosSimulator: iosSimulator.live(
      'full:fixture-replays',
      'a fixture .ad flow runs through public replay',
    ),
    macos: macos.gap('No command-specific macOS replay evidence exists beyond the suite runner'),
    tvos: tvos.gap('No tvOS-specific replay command evidence exists yet'),
    web: web.contract(
      'src/daemon/handlers/__tests__/session-command-replay.test.ts',
      'replay inherits the parent web platform selector for each invoked step',
      'replay re-invokes each recorded step with no platform branch, so a web selector threads through unchanged',
    ),
    linux: linux.commandEvidenceLive(
      'the command-evidence lane replays a dedicated Linux script with a live session',
    ),
  },
  [C.test]: {
    androidEmulator: androidEmulator.live(
      'full:fixture-replays',
      'deterministic fixture suite emits JUnit without retries',
    ),
    iosSimulator: iosSimulator.live(
      'full:fixture-replays',
      'fixture scripts run as a suite with JUnit artifacts',
    ),
    macos: macos.gap('No command-specific macOS test-suite evidence exists yet'),
    tvos: tvos.gap('No tvOS-specific test-suite command evidence exists yet'),
    web: web.gap(
      "Web test-suite execution has no executable web evidence: ReplayTestPlatform = Exclude<PlatformSelector, 'web'> structurally excludes web from the declared-platform filter, so `test --platform web` can never select a script (proven by a regression test in session-command-replay.test.ts) — that is evidence of what the command cannot do, not that it works on web",
    ),
    linux: linux.commandEvidenceLive(
      'the command-evidence lane runs a dedicated Linux script as a test suite',
    ),
  },
  [C.clipboard]: {
    androidEmulator: androidEmulator.contract(
      ANDROID_LIFECYCLE_CONTRACT_EVIDENCE,
      'provider scenario round-trips Android clipboard text',
    ),
    iosSimulator: iosSimulator.live(
      'full:lifecycle-system',
      'Unicode clipboard value round-trips exactly',
    ),
    macos: macos.live(
      'provider:macos-desktop',
      'the provider scenario round-trips desktop clipboard text',
    ),
    tvos: tvos.gap('No tvOS-specific clipboard command evidence exists yet'),
    web: web.contract(
      'packages/platform-web/src/runtime.test.ts',
      'clipboard, the app switcher, app events, settings and alerts carry no web bucket',
      'the exact-owner runtime fact rejects native clipboard operations on the web target',
    ),
    linux: linux.contract(
      'packages/platform-linux/src/__tests__/clipboard.test.ts',
      'writeLinuxClipboard uses xclip with stdin on X11',
      'Linux clipboard writes through the supported X11 host-tool seam',
    ),
  },
  [C.keyboard]: {
    androidEmulator: androidEmulator.live(
      'smoke:keyboard-ime',
      'safe dismissal hides keyboard without navigating Back',
    ),
    iosSimulator: iosSimulator.live(
      'smoke:form-input',
      'real keyboard dismissal reports dismissed=true and visible=false',
    ),
    macos: macos.contract(
      'packages/platform-apple/src/runtime.test.ts',
      'classifies back/home/app-switcher/orientation/tv-remote/keyboard facts for the %s leaf',
      'the exact-owner runtime fact rejects keyboard actions on the macOS AppKit desktop leaf',
    ),
    tvos: tvos.contract(
      'packages/platform-apple/src/runtime.test.ts',
      'classifies back/home/app-switcher/orientation/tv-remote/keyboard facts for the %s leaf',
      'the exact-owner runtime fact rejects keyboard input on the tvOS focus-only leaf',
    ),
    web: web.contract(
      'packages/platform-web/src/runtime.test.ts',
      'back/home/orientation/tv-remote/keyboard never carried a web capability bucket',
      'the exact-owner runtime fact rejects native keyboard operations on the web target',
    ),
    linux: linux.contract(
      LINUX_RUNTIME_EVIDENCE.path,
      LINUX_RUNTIME_EVIDENCE.test,
      'the exact-owner runtime fact rejects native keyboard control on every Linux leaf',
    ),
  },
  [C.install]: {
    androidEmulator: androidEmulator.live(
      'smoke:fixture-bootstrap',
      'public CLI installs cached/repacked fixture APK',
    ),
    iosSimulator: iosSimulator.live(
      'smoke:inventory-install',
      'public CLI installs the cached fixture .app',
    ),
    macos: macos.contract(
      'packages/platform-apple/src/deployment/runtime.test.ts',
      'classifies deployment facts for the %s denominator cell',
      'Apple deployment facts close application installation on the macOS host',
    ),
    tvos: tvos.contract(
      'packages/platform-apple/src/deployment/runtime.test.ts',
      'classifies deployment facts for the %s denominator cell',
      'shared Apple deployment facts admit app installation on tvOS simulators',
    ),
    web: web.contract(
      'packages/platform-web/src/runtime.test.ts',
      'install and reinstall share the runtime-owned unavailable deploy fact',
      'the web runtime fact rejects native app installation',
    ),
    linux: linux.gap('No Linux-specific application installation command evidence exists yet'),
  },
  [C.reinstall]: {
    androidEmulator: androidEmulator.contract(
      ANDROID_LIFECYCLE_CONTRACT_EVIDENCE,
      'provider scenario validates APK and bundle reinstall identities',
    ),
    iosSimulator: iosSimulator.live(
      'full:device-lifecycle',
      'cached fixture is reinstalled with typed bundle identity and app path',
    ),
    macos: macos.contract(
      'packages/platform-apple/src/deployment/runtime.test.ts',
      'classifies deployment facts for the %s denominator cell',
      'Apple deployment facts close application reinstallation on the macOS host',
    ),
    tvos: tvos.contract(
      'packages/platform-apple/src/deployment/runtime.test.ts',
      'classifies deployment facts for the %s denominator cell',
      'shared Apple deployment facts admit the operation used by tvOS install and reinstall',
    ),
    web: web.contract(
      'packages/platform-web/src/runtime.test.ts',
      'install and reinstall share the runtime-owned unavailable deploy fact',
      'the web runtime fact rejects native app reinstallation',
    ),
    linux: linux.gap('No Linux-specific application reinstallation command evidence exists yet'),
  },
  [C.push]: {
    androidEmulator: androidEmulator.live(
      'full:lifecycle-system',
      'typed broadcast extras are persisted by the fixture receiver and rendered after refresh',
    ),
    iosSimulator: iosSimulator.contract(
      'packages/platform-apple/src/core/__tests__/apps.test.ts',
      'pushIosNotification uses simctl push with temporary payload file',
      'simctl push dispatch; fixture has no notification entitlement or UI oracle',
    ),
    macos: macos.contract(
      'packages/platform-apple/src/deployment/runtime.test.ts',
      'classifies deployment facts for the %s denominator cell',
      'Apple deployment facts close push delivery on the macOS host',
    ),
    tvos: tvos.contract(
      'packages/platform-apple/src/deployment/runtime.test.ts',
      'classifies deployment facts for the %s denominator cell',
      'shared Apple deployment facts admit simulator push notifications for tvOS',
    ),
    web: web.contract(
      'packages/platform-web/src/runtime.test.ts',
      'push reports the runtime-owned unavailable readiness and push facts',
      'the web runtime fact rejects native push notification delivery',
    ),
    linux: linux.gap('No Linux-specific push delivery command evidence exists yet'),
  },
  [C.triggerAppEvent]: {
    androidEmulator: androidEmulator.contract(
      ANDROID_LIFECYCLE_CONTRACT_EVIDENCE,
      'provider scenario validates Android deep-link event delivery',
    ),
    iosSimulator: iosSimulator.live(
      'full:lifecycle-system',
      'custom-scheme event name and JSON payload render in the fixture',
    ),
    macos: macos.contract(
      'src/daemon/app-event-delivery.test.ts',
      'trigger-app-event supports macOS and prefers macOS template',
      'macOS app-event dispatch selects the macOS URL template',
    ),
    tvos: tvos.gap('No tvOS-specific app-event command evidence exists yet'),
    web: web.contract(
      'packages/platform-web/src/runtime.test.ts',
      'clipboard, the app switcher, app events, settings and alerts carry no web bucket',
      'the exact-owner runtime fact rejects native app-event delivery on the web target',
    ),
    linux: linux.contract(
      LINUX_RUNTIME_EVIDENCE.path,
      LINUX_RUNTIME_EVIDENCE.test,
      'the exact-owner runtime fact rejects native application event delivery on Linux',
    ),
  },
  [C.open]: {
    androidEmulator: androidEmulator.live(
      'smoke:automation-system',
      'cold deep link and normal fixture launch render landmarks',
    ),
    iosSimulator: iosSimulator.live(
      'smoke:automation-input',
      'fixture cold launch and deep route become visible',
    ),
    macos: macos.live(
      'replay:system-settings',
      'the System Settings replay opens the macOS target app',
    ),
    tvos: tvos.contract(
      TVOS_REMOTE_EVIDENCE.path,
      TVOS_REMOTE_EVIDENCE.test,
      'the existing provider scenario launches a tvOS app through the Apple tool provider',
    ),
    web: web.live('the managed browser opens the local fixture page'),
    linux: linux.replayLive('the existing Linux replay opens gnome-calculator'),
  },
  [C.prepare]: {
    androidEmulator: androidEmulator.contract(
      ANDROID_APPLICATION_LIFECYCLE_CONTRACT_EVIDENCE,
      'Android prepare fails closed through its unavailable prepareAppleRunner fact',
    ),
    iosSimulator: iosSimulator.workflowLive(
      '.github/workflows/ios.yml',
      'Preflight iOS runner through public CLI',
      'cached XCTest runner is prepared once before Settings and fixture suites',
    ),
    macos: macos.live(
      'provider:macos-desktop',
      'the provider scenario prepares the macOS XCTest runner through its lifecycle provider',
    ),
    tvos: tvos.gap('No tvOS-specific runner preparation command evidence exists yet'),
    web: web.contract(
      'packages/platform-web/src/runtime.test.ts',
      'preserves a narrow web provider dump including empty successful entries',
      'web runtime facts keep Apple runner preparation unavailable',
    ),
    linux: linux.contract(
      LINUX_RUNTIME_EVIDENCE.path,
      LINUX_RUNTIME_EVIDENCE.test,
      'Linux runtime facts explicitly report Apple runner preparation unavailable',
    ),
  },
  [C.batch]: {
    androidEmulator: androidEmulator.live(
      'full:observability-artifacts',
      'nested get and is results retain their Android fixture evidence',
    ),
    iosSimulator: iosSimulator.live(
      'full:observability-artifacts',
      'nested get/is results are asserted',
    ),
    macos: macos.gap('No command-specific macOS batch evidence exists yet'),
    tvos: tvos.gap('No tvOS-specific batch command evidence exists yet'),
    web: web.contract(
      'src/daemon/session-lifecycle/internal/__tests__/session-devices-batch-runtime.test.ts',
      'batch step forwards the parent web platform selector to each invoked step',
      'batch re-invokes each step through the normal dispatcher with no platform branch, so a web selector threads through unchanged',
    ),
    linux: linux.commandEvidenceLive(
      'the command-evidence lane executes two live Linux read steps',
    ),
  },
  [C.close]: {
    androidEmulator: androidEmulator.live(
      'smoke:capture-close',
      'session inventory proves fixture lease removal',
    ),
    iosSimulator: iosSimulator.live(
      'smoke:capture-close',
      'session inventory proves the app lease is removed',
    ),
    macos: macos.contract(
      'src/daemon/handlers/__tests__/session-relaunch-close.test.ts',
      'close on macOS session stops runner and dismisses automation alert before delete',
      'macOS close stops the runner, dismisses automation state, and deletes the session',
    ),
    tvos: tvos.contract(
      TVOS_REMOTE_EVIDENCE.path,
      TVOS_REMOTE_EVIDENCE.test,
      'the existing provider scenario terminates the tvOS app and releases the session',
    ),
    web: web.live('close releases the managed browser session during smoke cleanup'),
    linux: linux.contract(
      LINUX_PROVIDER_EVIDENCE.path,
      LINUX_PROVIDER_EVIDENCE.test,
      'Linux provider scenario closes the calculator and observes the desktop close call',
    ),
  },
  [C.snapshot]: {
    androidEmulator: androidEmulator.live(
      'smoke:automation-system',
      'interactive tree exposes Android resource-id fixture nodes',
    ),
    iosSimulator: iosSimulator.live(
      'smoke:automation-input',
      'scoped interactive tree includes the stable fixture title',
    ),
    macos: macos.live(
      'replay:system-settings',
      'the System Settings replay captures interactive macOS accessibility snapshots',
    ),
    tvos: tvos.gap('No tvOS-specific snapshot command evidence exists yet'),
    web: web.live('interactive snapshot exposes the fixture ready marker and form controls'),
    linux: linux.replayLive('the existing Linux replay captures the calculator accessibility tree'),
  },
  [C.diff]: {
    androidEmulator: androidEmulator.live(
      'smoke:automation-system',
      'snapshot diff observes the Automation-to-Settings transition',
    ),
    iosSimulator: iosSimulator.live(
      'smoke:form-input',
      'snapshot diff observes a form state mutation',
    ),
    macos: macos.gap('No command-specific macOS snapshot-diff evidence exists yet'),
    tvos: tvos.gap('No tvOS-specific snapshot-diff command evidence exists yet'),
    web: web.contract(
      'packages/platform-web/src/runtime.test.ts',
      'diff shares the admitted captureSnapshot fact that live snapshot and diff both require',
      'web diff shares the browser-admitted snapshot capture that backs the live snapshot command',
    ),
    linux: linux.commandEvidenceLive(
      'the command-evidence lane observes a non-empty calculator snapshot mutation',
    ),
  },
  [C.wait]: {
    androidEmulator: androidEmulator.live(
      'smoke:automation-system',
      'wait observes durable fixture landmarks',
    ),
    iosSimulator: iosSimulator.live(
      'smoke:automation-input',
      'polling observes durable fixture state',
    ),
    macos: macos.live(
      'replay:system-settings',
      'the System Settings replay waits for named macOS UI state',
    ),
    tvos: tvos.gap('No tvOS-specific wait command evidence exists yet'),
    web: web.live('wait observes ready text and post-interaction fixture state'),
    linux: linux.replayLive(
      'the existing Linux replay waits for an observable calculator landmark',
    ),
  },
  [C.alert]: {
    androidEmulator: androidEmulator.live(
      'smoke:automation-system',
      'native alert actions update fixture-visible results',
    ),
    iosSimulator: iosSimulator.live(
      'smoke:automation-input',
      'native alert get, dismiss, and accept update the app',
    ),
    macos: macos.live(
      'provider:macos-desktop',
      'the provider scenario reads, accepts, and dismisses the macOS automation alert',
    ),
    tvos: tvos.gap('No tvOS-specific alert command evidence exists yet'),
    web: web.contract(
      'packages/platform-web/src/runtime.test.ts',
      'clipboard, the app switcher, app events, settings and alerts carry no web bucket',
      'the exact-owner runtime fact rejects native alert handling on the web target',
    ),
    linux: linux.contract(
      LINUX_RUNTIME_EVIDENCE.path,
      LINUX_RUNTIME_EVIDENCE.test,
      'the exact-owner runtime fact rejects native alert handling on Linux',
    ),
  },
  [C.settings]: {
    androidEmulator: androidEmulator.live(
      'full:lifecycle-system',
      'Android grant and deny permission transitions are observed by the fixture',
    ),
    iosSimulator: iosSimulator.live(
      'full:lifecycle-system',
      'appearance changes are visible in useColorScheme and restored',
    ),
    macos: macos.live(
      'provider:macos-desktop',
      'the provider scenario changes macOS appearance and permissions through the helper',
    ),
    tvos: tvos.gap('No tvOS-specific settings command evidence exists yet'),
    web: web.contract(
      'packages/platform-web/src/runtime.test.ts',
      'clipboard, the app switcher, app events, settings and alerts carry no web bucket',
      'the exact-owner runtime fact rejects native device settings on the web target',
    ),
    linux: linux.contract(
      LINUX_RUNTIME_EVIDENCE.path,
      LINUX_RUNTIME_EVIDENCE.test,
      'the exact-owner runtime fact rejects native device settings on Linux',
    ),
  },
  [C.reactNative]: {
    androidEmulator: androidEmulator.contract(
      ANDROID_LIFECYCLE_CONTRACT_EVIDENCE,
      'provider scenario returns Android overlay dismissal state',
    ),
    iosSimulator: iosSimulator.live(
      'full:observability-artifacts',
      'Release fixture returns typed detected=false and dismissed=false overlay state',
    ),
    macos: macos.gap('No command-specific macOS React Native inspection evidence exists yet'),
    tvos: tvos.gap('No tvOS-specific React Native inspection command evidence exists yet'),
    // R61: no owner fact refuses this command on a browser — its whole device work is one bound
    // `tapPoint` the web target admits — so it now runs and reports that no overlay is present.
    web: web.contract(
      'packages/platform-web/src/runtime.test.ts',
      'press shares the admitted tapPoint fact that live click, press and react-native require',
      'React Native overlay dismissal binds the same browser tap the live click command does',
    ),
    // R61: no owner fact refuses this command on Linux — its whole device work is one bound
    // `tapPoint`, the same cell the live click leg uses — so it now runs and reports truthfully
    // that no React Native overlay is present on a GTK desktop.
    linux: linux.contract(
      LINUX_PROVIDER_EVIDENCE.path,
      LINUX_PROVIDER_EVIDENCE.test,
      'React Native overlay dismissal binds the same desktop tap the press leg does',
    ),
  },
  [C.record]: {
    androidEmulator: androidEmulator.live(
      'full:observability-artifacts',
      'short visible fixture mutation produces a non-empty playable Android MP4',
    ),
    iosSimulator: iosSimulator.live(
      'full:observability-artifacts',
      'visible mutation produces a playable MP4',
    ),
    macos: macos.live(
      'provider:macos-recording',
      'the provider scenario records and finalizes a playable macOS MP4',
    ),
    tvos: tvos.gap('No tvOS-specific recording command evidence exists yet'),
    web: web.contract(
      'test/integration/provider-scenarios/web-desktop.test.ts',
      'start web recording',
      'web recording starts and stops through the scoped provider',
    ),
    linux: linux.gap('No Linux-specific recording command evidence exists yet'),
  },
  [C.trace]: {
    androidEmulator: androidEmulator.live(
      'full:observability-artifacts',
      'a visible fixture mutation creates non-empty trace diagnostics at the requested path',
    ),
    iosSimulator: iosSimulator.live(
      'full:observability-artifacts',
      'typed start/stop lifecycle retains the requested path and captures non-empty diagnostics',
    ),
    macos: macos.gap('No command-specific macOS trace evidence exists yet'),
    tvos: tvos.gap('No tvOS-specific trace command evidence exists yet'),
    web: web.contract(
      'src/daemon/handlers/__tests__/trace-runtime.test.ts',
      'starts and stops one trace through the session-owned trace slot on a web session',
      'session-scoped trace start/stop bookkeeping works the same for a web session as any other platform',
    ),
    linux: linux.gap('No Linux-specific trace command evidence exists yet'),
  },
  [C.find]: {
    androidEmulator: androidEmulator.live(
      'smoke:automation-system',
      'find observes the automation landmark',
    ),
    iosSimulator: iosSimulator.live(
      'smoke:automation-input',
      'find reports the automation heading',
    ),
    macos: macos.gap('No command-specific macOS find evidence exists yet'),
    tvos: tvos.gap('No tvOS-specific find command evidence exists yet'),
    web: web.live('find locates the ready marker through text and selector expressions'),
    linux: linux.commandEvidenceLive('the command-evidence lane resolves a live AT-SPI role match'),
  },
  [C.click]: {
    androidEmulator: androidEmulator.live(
      'smoke:automation-system',
      'resource-id selector opens fixture controls',
    ),
    iosSimulator: iosSimulator.live(
      'smoke:automation-input',
      'selector click opens the automation lab',
    ),
    macos: macos.live(
      'replay:system-settings',
      'the System Settings replay clicks a named macOS control',
    ),
    tvos: tvos.gap('No tvOS-specific click command evidence exists yet'),
    web: web.live('click changes the fixture status to Submitted'),
    // Promoted from command-contract to live: the desktop replay now clicks a resolved digit
    // button on real Linux hardware and the downstream wait only passes if the click landed
    // (formerly missed — AT-SPI extents were computed screen-absolute-wrong under GTK4; see
    // linux/atspi-dump.py).
    linux: linux.replayLive('the Linux desktop replay clicks a resolved calculator digit button'),
  },
  [C.fill]: {
    androidEmulator: androidEmulator.live(
      'smoke:form-input',
      'replacement form text is read back from Android UI',
    ),
    iosSimulator: iosSimulator.live(
      'smoke:form-input',
      'replacement text is read back from the fixture input',
    ),
    macos: macos.gap('No command-specific macOS fill evidence exists yet'),
    tvos: tvos.gap('No tvOS-specific fill command evidence exists yet'),
    web: web.live('fill updates the accessible email value and fixture status'),
    linux: linux.contract(
      LINUX_PROVIDER_EVIDENCE.path,
      LINUX_PROVIDER_EVIDENCE.test,
      'Linux provider scenario fills both a snapshot ref and coordinate target',
    ),
  },
  [C.longPress]: {
    androidEmulator: androidEmulator.live(
      'smoke:automation-system',
      '800ms hold increments durable fixture counter',
    ),
    iosSimulator: iosSimulator.live(
      'smoke:automation-input',
      'an 800ms hold increments the durable long-press counter',
    ),
    macos: macos.gap('No command-specific macOS long-press evidence exists yet'),
    tvos: tvos.gap('No tvOS-specific long-press command evidence exists yet'),
    web: web.contract(
      'packages/platform-web/src/runtime.ts',
      'longPress: readinessUnavailable',
      'the web runtime fact rejects touch long-press input',
    ),
    linux: linux.contract(
      LINUX_PROVIDER_EVIDENCE.path,
      LINUX_PROVIDER_EVIDENCE.test,
      'Linux provider scenario executes a coordinate long press',
    ),
  },
  [C.hover]: {
    androidEmulator: androidEmulator.contract(
      ANDROID_HOVER_RUNTIME_CONTRACT_EVIDENCE,
      'Android runtime facts reject hover with the pointer-only web contract hint',
    ),
    iosSimulator: iosSimulator.contract(
      'packages/platform-apple/src/runtime.ts',
      'hover: unavailable',
      'the Apple runtime fact rejects hover, a pointer-only web contract',
    ),
    macos: macos.contract(
      'packages/platform-apple/src/runtime.ts',
      'hover: unavailable',
      'the Apple runtime fact rejects pointer-only hover input on macOS',
    ),
    tvos: tvos.contract(
      'packages/platform-apple/src/runtime.ts',
      'hover: unavailable',
      'the Apple runtime fact rejects pointer-only hover input on tvOS',
    ),
    web: web.contract(
      'test/integration/provider-scenarios/web-desktop.test.ts',
      'hover submit ref',
      'web hover moves the pointer through the provider element handle',
    ),
    linux: linux.contract(
      'packages/platform-linux/src/runtime.ts',
      'hover: unsupportedPlatformLeaf',
      'the Linux runtime fact rejects pointer-only hover input',
    ),
  },
  [C.press]: {
    androidEmulator: androidEmulator.live(
      'smoke:automation-system',
      'semantic press updates durable fixture input state',
    ),
    iosSimulator: iosSimulator.live(
      'smoke:automation-input',
      'semantic press updates a durable input canary',
    ),
    macos: macos.live(
      'provider:macos-desktop',
      'the provider scenario presses a snapshot ref through the macOS helper',
    ),
    tvos: tvos.gap('No tvOS-specific press command evidence exists yet'),
    web: web.contract(
      'packages/platform-web/src/runtime.test.ts',
      'press shares the admitted tapPoint fact that live click, press and react-native require',
      'web press shares the browser-admitted tap operation that backs the live click command',
    ),
    linux: linux.contract(
      LINUX_PROVIDER_EVIDENCE.path,
      LINUX_PROVIDER_EVIDENCE.test,
      'Linux provider scenario presses a snapshot ref and coordinate target',
    ),
  },
  [C.type]: {
    androidEmulator: androidEmulator.live(
      'smoke:form-input',
      'typed suffix is read back from focused Android field',
    ),
    iosSimulator: iosSimulator.live(
      'smoke:form-input',
      'AX-independent first-responder typing appends and is read back from a focused fixture field',
    ),
    macos: macos.gap('No command-specific macOS type evidence exists yet'),
    tvos: tvos.gap('No tvOS-specific type command evidence exists yet'),
    web: web.contract(
      'test/integration/provider-scenarios/web-desktop.test.ts',
      'type suffix',
      'web type appends text to the focused field through the provider',
    ),
    // Promoted from command-contract to live: GTK4 gnome-calculator's entry previously exposed no
    // Text-interface content to selectors (a PyGObject binding call-pattern bug — see
    // linux/atspi-dump.py), so no tree-level assertion could hold. Fixed, so the desktop replay's
    // typed calculation now has a real wait assertion on the computed result.
    linux: linux.replayLive(
      'the Linux desktop replay types a calculation and its result is selectable',
    ),
  },
  [C.get]: {
    androidEmulator: androidEmulator.live(
      'smoke:automation-system',
      'get returns fixture automation canary text',
    ),
    iosSimulator: iosSimulator.live(
      'smoke:automation-input',
      'get returns automation canary text/attributes',
    ),
    macos: macos.live(
      'provider:macos-desktop',
      'the provider scenario reads snapshot-ref text from the macOS helper',
    ),
    tvos: tvos.gap('No tvOS-specific get command evidence exists yet'),
    web: web.live('get reads the ready marker text from the fixture'),
    linux: linux.contract(
      LINUX_PROVIDER_EVIDENCE.path,
      LINUX_PROVIDER_EVIDENCE.test,
      'Linux provider scenario reads the pressed snapshot ref text',
    ),
  },
  [C.is]: {
    androidEmulator: androidEmulator.live(
      'smoke:automation-system',
      'visible predicate passes and absent observes the unmounted Android modal control',
    ),
    iosSimulator: iosSimulator.live(
      'smoke:automation-input',
      'visible/editable predicates pass and absent observes the unmounted sheet control',
    ),
    macos: macos.live(
      'replay:system-settings',
      'the System Settings replay asserts a named macOS control exists',
    ),
    tvos: tvos.gap('No tvOS-specific predicate command evidence exists yet'),
    web: web.live('is visible passes for the Submit order control'),
    linux: linux.replayLive('the existing Linux replay verifies a calculator landmark exists'),
  },
  [C.back]: {
    androidEmulator: androidEmulator.live(
      'smoke:automation-system',
      'back returns from automation to the Settings tab',
    ),
    iosSimulator: iosSimulator.live(
      'smoke:automation-input',
      'back navigation returns from the automation route',
    ),
    macos: macos.live(
      'replay:system-settings',
      'the System Settings replay returns from the About pane',
    ),
    tvos: tvos.contract(
      TVOS_REMOTE_EVIDENCE.path,
      TVOS_REMOTE_EVIDENCE.test,
      'the existing provider scenario maps Back to the tvOS Menu remote press',
    ),
    web: web.contract(
      'packages/platform-web/src/runtime.test.ts',
      'back/home/orientation/tv-remote/keyboard never carried a web capability bucket',
      'the exact-owner runtime fact rejects native back navigation on the web target',
    ),
    linux: linux.contract(
      LINUX_PROVIDER_EVIDENCE.path,
      LINUX_PROVIDER_EVIDENCE.test,
      'Linux provider scenario dispatches Alt+Left through the semantic input provider',
    ),
  },
  [C.gesture]: {
    androidEmulator: androidEmulator.live(
      'full:fixture-replays',
      'helper-backed one- and two-pointer gestures produce every fixture transform effect',
    ),
    iosSimulator: iosSimulator.live(
      'full:fixture-replays',
      'fixture gesture counters prove pan/fling/pinch/rotate',
    ),
    macos: macos.contract(
      'packages/platform-apple/src/core/__tests__/interactions.test.ts',
      'performGestureApple composes macOS one-contact plans with the drag executor',
      'macOS gesture dispatch preserves the one-contact drag plan',
    ),
    tvos: tvos.contract(
      'src/daemon/__tests__/gesture-admission-parity.test.ts',
      'TV, spatial, watch, desktop, Linux, and web gesture policy stays explicit',
      'the typed Apple gesture policy refuses tvOS multi-touch while preserving the narrower gesture contract',
    ),
    // R52/R54: the web refusal moved from the capability matrix to the web owner's own gesture
    // facts, so the evidence is the cell test rather than a mechanical matrix denial.
    web: web.contract(
      'packages/platform-web/src/runtime.test.ts',
      'admits web scrolling and refuses every gesture tier',
      'the web runtime owner declares every gesture tier unavailable',
    ),
    linux: linux.contract(
      LINUX_PROVIDER_EVIDENCE.path,
      LINUX_PROVIDER_EVIDENCE.test,
      'Linux provider scenario executes a single-pointer pan through the semantic drag provider',
    ),
  },
  [C.home]: {
    androidEmulator: androidEmulator.live(
      'smoke:automation-system',
      'Home changes Android foreground evidence before the fixture is restored',
    ),
    iosSimulator: iosSimulator.live(
      'full:lifecycle-system',
      'fixture AppState becomes non-active and system pixels replace foreground pixels',
    ),
    macos: macos.contract(
      'packages/platform-apple/src/runtime.test.ts',
      'classifies back/home/app-switcher/orientation/tv-remote/keyboard facts for the %s leaf',
      'the exact-owner runtime fact rejects mobile Home navigation on the macOS leaf, which drives an already-running app with no springboard',
    ),
    tvos: tvos.contract(
      TVOS_REMOTE_EVIDENCE.path,
      TVOS_REMOTE_EVIDENCE.test,
      'the existing provider scenario maps Home to the tvOS Home remote press',
    ),
    web: web.contract(
      'packages/platform-web/src/runtime.test.ts',
      'back/home/orientation/tv-remote/keyboard never carried a web capability bucket',
      'the exact-owner runtime fact rejects native Home navigation on the web target',
    ),
    linux: linux.contract(
      LINUX_PROVIDER_EVIDENCE.path,
      LINUX_PROVIDER_EVIDENCE.test,
      'Linux provider scenario dispatches Super+D through the semantic input provider',
    ),
  },
  [C.tvRemote]: {
    androidEmulator: androidEmulator.contract(
      ANDROID_TV_REMOTE_RUNTIME_CONTRACT_EVIDENCE,
      'Android tv-remote admission is owned by its exact-owner runtime fact: available only for a real Android TV target, not the mobile emulator',
    ),
    iosSimulator: iosSimulator.contract(
      'packages/platform-apple/src/runtime.test.ts',
      'classifies back/home/app-switcher/orientation/tv-remote/keyboard facts for the %s leaf',
      'tv-remote admission is owned by its exact-owner runtime fact: available only for the tvOS leaf, not the iOS mobile simulator',
    ),
    macos: macos.contract(
      'packages/platform-apple/src/runtime.test.ts',
      'classifies back/home/app-switcher/orientation/tv-remote/keyboard facts for the %s leaf',
      'the exact-owner runtime fact admits TV remote input only for the tvOS leaf, not macOS',
    ),
    tvos: tvos.contract(
      'packages/platform-apple/src/runtime.test.ts',
      'classifies back/home/app-switcher/orientation/tv-remote/keyboard facts for the %s leaf',
      'the exact-owner runtime fact admits tv-remote for the tvOS leaf, which drives navigation through XCUIRemote presses',
    ),
    web: web.contract(
      'packages/platform-web/src/runtime.test.ts',
      'back/home/orientation/tv-remote/keyboard never carried a web capability bucket',
      'the exact-owner runtime fact rejects TV remote input on the web target',
    ),
    linux: linux.contract(
      LINUX_RUNTIME_EVIDENCE.path,
      LINUX_RUNTIME_EVIDENCE.test,
      'the exact-owner runtime fact rejects TV remote input on every Linux leaf',
    ),
  },
  [C.orientation]: {
    androidEmulator: androidEmulator.live(
      'smoke:automation-system',
      'fixture window state observes landscape then portrait Android rotation',
    ),
    iosSimulator: iosSimulator.live(
      'full:lifecycle-system',
      'native runner reads back exact landscape-left and portrait device states',
    ),
    macos: macos.contract(
      'packages/platform-apple/src/runtime.test.ts',
      'classifies back/home/app-switcher/orientation/tv-remote/keyboard facts for the %s leaf',
      'the exact-owner runtime fact rejects device orientation changes on the macOS leaf',
    ),
    tvos: tvos.contract(
      'packages/platform-apple/src/runtime.test.ts',
      'classifies back/home/app-switcher/orientation/tv-remote/keyboard facts for the %s leaf',
      'the exact-owner runtime fact rejects device orientation changes on the tvOS leaf',
    ),
    web: web.contract(
      'packages/platform-web/src/runtime.test.ts',
      'back/home/orientation/tv-remote/keyboard never carried a web capability bucket',
      'the exact-owner runtime fact rejects native orientation changes on the web target',
    ),
    linux: linux.contract(
      LINUX_RUNTIME_EVIDENCE.path,
      LINUX_RUNTIME_EVIDENCE.test,
      'the exact-owner runtime fact rejects native orientation changes on every Linux leaf',
    ),
  },
  [C.scroll]: {
    androidEmulator: androidEmulator.live(
      'full:fixture-replays',
      'edge-aware catalog traversal reaches its footer and safely rediscovers the top',
    ),
    iosSimulator: iosSimulator.live(
      'full:lifecycle-system',
      'bottom-edge traversal executes a live scroll pass and reports the reached edge',
    ),
    macos: macos.live(
      'provider:macos-desktop',
      'the provider scenario maps desktop scrolling to the macOS wheel runner command',
    ),
    tvos: tvos.contract(
      TVOS_REMOTE_EVIDENCE.path,
      TVOS_REMOTE_EVIDENCE.test,
      'the existing provider scenario maps tvOS scroll direction to a remote press',
    ),
    web: web.contract(
      'test/integration/provider-scenarios/web-desktop.test.ts',
      'scroll by pixels',
      'web scroll moves the provider-backed page by the requested pixels',
    ),
    linux: linux.contract(
      'packages/platform-linux/src/__tests__/input-actions.test.ts',
      'scrollLinux uses ydotool mousemove --wheel for vertical scroll',
      'Linux scroll dispatch uses the Wayland ydotool wheel primitive',
    ),
  },
  [C.swipe]: {
    androidEmulator: androidEmulator.live(
      'full:fixture-replays',
      'direct fixture swipe moves the catalog before edge-aware recovery',
    ),
    iosSimulator: iosSimulator.live(
      'full:fixture-replays',
      'fixture direction canary proves both compact-safe directional swipes move content',
    ),
    macos: macos.gap('No command-specific macOS swipe evidence exists yet'),
    tvos: tvos.gap('No tvOS-specific swipe command evidence exists yet'),
    web: web.contract(
      'packages/platform-web/src/runtime.test.ts',
      'admits web scrolling and refuses every gesture tier',
      'swipe shares the gesture tiers the web runtime owner declares unavailable',
    ),
    linux: linux.commandEvidenceLive('the command-evidence lane dispatches a coordinate swipe'),
  },
  [C.focus]: {
    androidEmulator: androidEmulator.live(
      'smoke:form-input',
      'snapshot-derived Android field point receives typed text',
    ),
    iosSimulator: iosSimulator.live(
      'smoke:form-input',
      'snapshot-derived field coordinates focus the target before typed text is read back',
    ),
    macos: macos.gap('No command-specific macOS focus evidence exists yet'),
    tvos: tvos.gap('No tvOS-specific focus command evidence exists yet'),
    web: web.contract(
      'src/core/__tests__/web-interactor.test.ts',
      'web interactor delegates first-slice operations to the scoped provider',
      'web focus delegates to the scoped provider click primitive',
    ),
    // Promoted from command-contract to live by #1925: the desktop replay now runs a coordinate
    // focus on real Linux hardware, so the migrated `focusPoint` path has live changed-path
    // evidence rather than only the provider scenario at LINUX_PROVIDER_EVIDENCE.
    linux: linux.replayLive('the Linux desktop replay focuses a coordinate on real hardware'),
  },
  [C.screenshot]: {
    androidEmulator: androidEmulator.live(
      'smoke:capture-close',
      'captured fixture file has a valid PNG signature',
    ),
    iosSimulator: iosSimulator.live(
      'smoke:capture-close',
      'captured file has a valid PNG signature',
    ),
    macos: macos.live(
      'replay:system-settings',
      'the System Settings replay writes a macOS screenshot artifact',
    ),
    tvos: tvos.gap('No tvOS-specific screenshot command evidence exists yet'),
    web: web.live('screenshot creates a valid 640x480 PNG artifact'),
    linux: linux.replayLive('the existing Linux replay creates a screenshot artifact'),
  },
  [C.viewport]: {
    androidEmulator: androidEmulator.contract(
      ANDROID_VIEWPORT_RUNTIME_CONTRACT_EVIDENCE,
      'Android viewport fails closed through its unavailable exact-owner runtime fact',
    ),
    iosSimulator: iosSimulator.contract(
      'src/daemon/__tests__/viewport-runtime.test.ts',
      'rejects an unavailable exact-owner fact before binding',
      'iOS viewport fails closed through its unavailable exact-owner runtime fact',
    ),
    macos: macos.contract(
      'packages/platform-apple/src/runtime.test.ts',
      'classifies the %s leaf explicitly',
      'Apple runtime facts reject viewport resizing on the macOS host',
    ),
    tvos: tvos.gap('No tvOS-specific viewport command evidence exists yet'),
    web: web.live('viewport resizes the browser and the PNG reports 640x480 dimensions'),
    linux: linux.contract(
      LINUX_RUNTIME_EVIDENCE.path,
      LINUX_RUNTIME_EVIDENCE.test,
      'Linux runtime facts explicitly report viewport changes unavailable',
    ),
  },
  [C.appSwitcher]: {
    androidEmulator: androidEmulator.live(
      'smoke:automation-system',
      'Recents pixels differ from Home and the fixture restores through Android app state',
    ),
    iosSimulator: iosSimulator.live(
      'full:lifecycle-system',
      'app switcher covers fixture controls and differs from Home before restoration',
    ),
    macos: macos.contract(
      'packages/platform-apple/src/runtime.test.ts',
      'classifies back/home/app-switcher/orientation/tv-remote/keyboard facts for the %s leaf',
      'the exact-owner runtime fact rejects app-switcher navigation on the macOS host leaf',
    ),
    tvos: tvos.gap('No tvOS-specific app-switcher command evidence exists yet'),
    web: web.contract(
      'packages/platform-web/src/runtime.test.ts',
      'clipboard, the app switcher, app events, settings and alerts carry no web bucket',
      'the exact-owner runtime fact rejects native app-switcher navigation on the web target',
    ),
    linux: linux.contract(
      LINUX_RUNTIME_EVIDENCE.path,
      LINUX_RUNTIME_EVIDENCE.test,
      'the exact-owner runtime fact rejects native app-switcher navigation on Linux',
    ),
  },
  [C.installFromSource]: {
    androidEmulator: androidEmulator.contract(
      ANDROID_INSTALL_SOURCE_CONTRACT_EVIDENCE,
      'Android install-source resolves an installable artifact with typed identity',
    ),
    iosSimulator: iosSimulator.contract(
      'packages/platform-apple/src/deployment/runtime.test.ts',
      'exposes only fact-admitted Apple deployment operations',
      'fact-admitted local .app materialization, simulator install dispatch, and typed identity',
    ),
    macos: macos.contract(
      'packages/platform-apple/src/deployment/runtime.test.ts',
      'classifies deployment facts for the %s denominator cell',
      'Apple deployment facts close source installation on the macOS host',
    ),
    tvos: tvos.contract(
      'packages/platform-apple/src/deployment/runtime.test.ts',
      'classifies deployment facts for the %s denominator cell',
      'shared Apple deployment operations expose source materialization for admitted tvOS deployment',
    ),
    web: web.contract(
      'packages/platform-web/src/runtime.test.ts',
      'install-from-source reports the runtime-owned unavailable materialize and deploy facts',
      'the web runtime fact rejects source-based app installation',
    ),
    linux: linux.gap('No Linux-specific source-install command evidence exists yet'),
  },
} satisfies Record<PublicCommand, CommandCoverageDeclaration>;

/**
 * The per-platform view: one platform's column of the declaration table, in catalog order.
 * Built at load time so no projected record is committed and none can drift from the table.
 */
export function projectCoverage<Platform extends CoveragePlatform>(
  platform: Platform,
): Record<PublicCommand, CommandCoverageDeclaration[Platform]> {
  return Object.fromEntries(
    Object.entries(COMMAND_COVERAGE_DECLARATIONS).map(([command, declaration]) => [
      command,
      declaration[platform],
    ]),
  ) as Record<PublicCommand, CommandCoverageDeclaration[Platform]>;
}
