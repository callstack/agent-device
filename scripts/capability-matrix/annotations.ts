// The hand-written half of the capabilities page: what each generated row is
// called, which commands it stands for, where it is documented, and the honest
// scope sentence for capabilities the runtime facts do not decide.
//
// Everything factual about which target supports what comes from the collected
// matrix: `answer` and the one cell check in generate.ts partition each row's
// advertised operations (its commands' declared uses, narrowed by `advertises`
// where the row label claims less) across every cell. A plain `Yes` must have
// the whole set admitted; a qualified cell splits that same set into `admits`
// (checked present) and `refuses` (checked absent), and generation fails when
// the split stops holding, so removing or renaming an operation fails the
// generator until that cell is updated. The drift guard
// (test/repo-guards/capability-matrix.test.ts) fails when a row names a command
// the registry does not have, and when a registry fact command belongs to no
// row, so a capability cannot be added, renamed, or dropped without an edit here.

const docs = (path: string, anchor?: string) => `/docs/${path}${anchor ? `#${anchor}` : ''}`;

/**
 * A cell whose text qualifies the bare `Yes` the facts answer, keyed by the
 * column's representative target id. `admits` and `refuses` must split the
 * row's advertised operation set exactly: every advertised operation in one
 * list or the other, each checked against the facts (admits present, refuses
 * absent). A cell that names neither behaves like a plain `Yes` and needs the
 * whole set admitted. Generation fails when the split stops holding, so a cell
 * cannot quietly outlive the facts behind its text.
 */
export type CellQualification = Readonly<{
  /** The cell's whole text, replacing `Yes`. One sentence, no pipes. */
  text: string;
  /** Advertised operations the text names as available; any absence fails generation. */
  admits?: readonly string[];
  /** Advertised operations the text names as unavailable; any presence fails generation. */
  refuses?: readonly string[];
}>;

export type FactRow = Readonly<{
  id: string;
  /** What a reader would type to ask for this. */
  label: string;
  /** The runtime-fact commands this row reports. All of them must share one answer per target. */
  commands: readonly string[];
  /** Doc page (and section) that proves the row. */
  link: string;
  /**
   * The operations each `Yes` cell of this row promises. The default is every
   * operation the row's commands name in their declared uses; a row narrows it
   * only where its commands admit on any one of several alternative uses and
   * the label does not claim the rest. A `Yes` cell never renders while a
   * promised operation is refused, so removing one fails generation even when
   * the command stays admitted through another use.
   */
  advertises?: readonly string[];
  /** What a Yes cell does not claim, where the cell alone would mislead. Target-neutral. */
  note?: string;
  /** Per-column cell text, for columns the bare Yes or No would overstate. */
  cells?: Readonly<Record<string, CellQualification>>;
}>;

export type MatrixSection = Readonly<{
  id: string;
  title: string;
  rows: readonly FactRow[];
}>;

export type ScopeRow = Readonly<{
  id: string;
  label: string;
  /** Registry commands the scope sentence names. They must exist; they carry no device facts. */
  commands: readonly string[];
  /** What the capability needs, and where it does not run. */
  scope: string;
  link: string;
}>;

export const MATRIX_SECTIONS: readonly MatrixSection[] = [
  {
    id: 'inspect',
    title: 'Inspect and verify the UI',
    rows: [
      {
        id: 'snapshot-tree',
        label: 'Accessibility snapshot and snapshot diff',
        commands: ['snapshot', 'diff'],
        link: docs('snapshots'),
        advertises: ['captureSnapshot'],
        note: 'A capture returns a tree only when the app or desktop exposes an accessibility tree.',
      },
      {
        id: 'refs-selectors',
        label: 'Refs, selectors, element lookup, and attribute reads',
        commands: ['find', 'get', 'is', 'focus'],
        link: docs('selectors'),
        advertises: ['captureSnapshot', 'focusPoint'],
      },
      {
        id: 'screenshot',
        label: 'Screenshots',
        commands: ['screenshot'],
        link: docs('commands', 'media-and-logs'),
      },
      {
        id: 'wait',
        label: 'Wait for text, selectors, and timeouts',
        commands: ['wait'],
        link: docs('commands', 'wait-and-alerts'),
        advertises: ['captureSnapshot'],
      },
    ],
  },
  {
    id: 'interact',
    title: 'Interact with the app',
    rows: [
      {
        id: 'tap-fill',
        label: 'Tap, press, and fill',
        commands: ['click', 'press', 'fill'],
        link: docs('commands', 'interactions'),
        note: 'Android types non-ASCII text through the test input method: automatically on emulators, and on physical devices only with `open --test-ime`.',
      },
      {
        id: 'type',
        label: 'Type into the focused field',
        commands: ['type'],
        link: docs('commands', 'interactions'),
        note: 'Revyl enters text only at a point, so it refuses `type`; use `fill` on the field instead.',
      },
      {
        id: 'long-press',
        label: 'Long press',
        commands: ['longpress'],
        link: docs('commands', 'interactions'),
      },
      {
        id: 'scroll',
        label: 'Scroll',
        commands: ['scroll'],
        link: docs('commands', 'scroll'),
      },
      {
        id: 'gestures',
        label: 'Gesture plans and swipes',
        commands: ['gesture', 'swipe'],
        link: docs('commands', 'pointer-and-gestures'),
        advertises: ['performGesturePlan', 'captureSnapshot'],
        note: 'Multi-touch plans are part of `gesture` where the target runs them; a plan using an operation the target lacks fails at that step.',
      },
      {
        id: 'hover-viewport',
        label: 'Hover and viewport size',
        commands: ['hover', 'viewport'],
        link: docs('commands', 'web-automation'),
      },
      {
        id: 'alerts',
        label: 'Read, accept, and dismiss system alerts',
        commands: ['alert'],
        link: docs('commands', 'wait-and-alerts'),
      },
      {
        id: 'keyboard',
        label: 'Keyboard dismiss, enter, and status',
        commands: ['keyboard'],
        link: docs('commands', 'keyboard'),
        cells: {
          'ios-sim': {
            text: 'Dismiss and enter; status unsupported',
            admits: ['keyboardDismiss', 'keyboardEnter'],
            refuses: ['keyboardStatus'],
          },
          'ios-device': {
            text: 'Dismiss and enter; status unsupported',
            admits: ['keyboardDismiss', 'keyboardEnter'],
            refuses: ['keyboardStatus'],
          },
          'harmonyos-emulator': {
            text: 'Dismiss and enter; status unsupported',
            admits: ['keyboardDismiss', 'keyboardEnter'],
            refuses: ['keyboardStatus'],
          },
          'harmonyos-device': {
            text: 'Dismiss and enter; status unsupported',
            admits: ['keyboardDismiss', 'keyboardEnter'],
            refuses: ['keyboardStatus'],
          },
          'browserstack-ios': {
            text: 'Dismiss only; status and enter unsupported',
            admits: ['keyboardDismiss'],
            refuses: ['keyboardStatus', 'keyboardEnter'],
          },
          'aws-device-farm-ios': {
            text: 'Dismiss only; status and enter unsupported',
            admits: ['keyboardDismiss'],
            refuses: ['keyboardStatus', 'keyboardEnter'],
          },
        },
      },
      {
        id: 'react-native-overlays',
        label: 'React Native overlay dismissal',
        commands: ['react-native'],
        link: docs('commands', 'react-native-overlays'),
        note: 'The command runs wherever tapping runs; it answers `detected: false` on a surface with no React Native overlay. Only iOS and Android apps present dismissable development overlays.',
      },
    ],
  },
  {
    id: 'lifecycle',
    title: 'Apps and devices',
    rows: [
      {
        id: 'open-close',
        label: 'Open and close apps, URLs, and deep links',
        commands: ['open', 'close'],
        link: docs('commands', 'navigation'),
        advertises: [
          'resolveOpenTarget',
          'prepareApplicationOpen',
          'openApplication',
          'closeApplication',
          'finalizeApplicationClose',
        ],
        cells: {
          'vega-vvd': {
            text: 'App open/close only; URLs and deep links rejected',
          },
        },
      },
      {
        id: 'install',
        label: 'Install and reinstall an app',
        commands: ['install', 'reinstall'],
        link: docs('commands', 'app-install-in-place'),
      },
      {
        id: 'uninstall',
        label: 'Uninstall an app',
        commands: ['uninstall'],
        link: docs('commands', 'app-uninstall'),
      },
      {
        id: 'install-source',
        label: 'Install from a source URL',
        commands: ['install-from-source'],
        link: docs('commands', 'app-install-from-source-url'),
      },
      {
        id: 'apps',
        label: 'Installed app list',
        commands: ['apps'],
        link: docs('commands', 'app-state-and-app-lists'),
      },
      {
        id: 'app-state',
        label: 'Foreground app state',
        commands: ['appstate'],
        link: docs('commands', 'app-state-and-app-lists'),
        note: 'On iOS and macOS a bound session that owns an app identity or surface answers this from its own state, even where the sessionless probe cannot see a foreground app.',
      },
      {
        id: 'app-switcher',
        label: 'App switcher',
        commands: ['app-switcher'],
        link: docs('commands', 'navigation'),
      },
      {
        id: 'boot',
        label: 'Get the device ready and boot simulators and emulators',
        commands: ['boot'],
        link: docs('commands', 'navigation'),
        advertises: ['bootTarget'],
        note: 'On a simulator or emulator this starts the machine. On a physical or hosted device it waits for the device that is already provisioned to answer rather than starting one.',
      },
      {
        id: 'shutdown',
        label: 'Shut down a simulator or emulator',
        commands: ['shutdown'],
        link: docs('commands', 'navigation'),
      },
      {
        id: 'prepare-runner',
        label: 'Prepare the Apple runner',
        commands: ['prepare'],
        link: docs('commands', 'prepare-apple-runner'),
      },
    ],
  },
  {
    id: 'evidence',
    title: 'Evidence and diagnostics',
    rows: [
      {
        id: 'record',
        label: 'Screen recording',
        commands: ['record'],
        link: docs('commands', 'media-and-logs'),
        note: 'An iOS physical device records runner screenshots, not a native video stream: no audio, and dropped frames are expected. An Android clip covers 180 seconds, and a longer recording arrives as chunks.',
      },
      {
        id: 'logs',
        label: 'App logs',
        commands: ['logs'],
        link: docs('debugging-profiling', 'logs'),
      },
      {
        id: 'network',
        label: 'HTTP(S) request inspection',
        commands: ['network'],
        link: docs('debugging-profiling', 'network-inspection'),
        note: 'Local native app sessions inspect the HTTP(S) entries present in the session app log; traffic absent from those logs is not captured. The three WebDriver provider clouds refuse a live dump: their traffic is on the provider side, and TestMu AI can return provider network-log artifacts after the session ends. Managed web sessions inspect the browser request history.',
      },
      {
        id: 'perf',
        label: 'Performance samples (frames, memory, CPU profiles)',
        commands: ['perf'],
        link: docs('debugging-profiling', 'performance-snapshots'),
        cells: {
          'harmonyos-emulator': {
            text: 'Process RSS memory sample only; frames, memory-snapshot artifacts, CPU profiles, and native captures report unavailable',
            admits: ['perfFrames', 'perfMemorySample', 'perfMemorySnapshot'],
            refuses: [
              'perfNativeCaptureStart',
              'perfNativeCaptureReattach',
              'perfNativeCaptureCleanup',
              'perfProfileReport',
            ],
          },
          'harmonyos-device': {
            text: 'Process RSS memory sample only; frames, memory-snapshot artifacts, CPU profiles, and native captures report unavailable',
            admits: ['perfFrames', 'perfMemorySample', 'perfMemorySnapshot'],
            refuses: [
              'perfNativeCaptureStart',
              'perfNativeCaptureReattach',
              'perfNativeCaptureCleanup',
              'perfProfileReport',
            ],
          },
          'ios-device': {
            text: 'Frames, memory, and CPU profiles; memory-snapshot artifact reports unavailable',
          },
        },
      },
      {
        id: 'audio',
        label: 'Audio probe',
        commands: ['audio'],
        link: docs('debugging-profiling', 'audio-probes'),
        advertises: ['audioProbeStart', 'audioProbeReattach', 'audioProbeCleanup'],
        note: 'A simulator, emulator, or macOS desktop session samples host system audio, which works on a macOS agent host and needs Screen Recording permission there.',
        cells: {
          'web-browser': {
            text: 'Page media probe only; host capture unsupported',
            refuses: ['audioProbeStart', 'audioProbeReattach', 'audioProbeCleanup'],
          },
        },
      },
    ],
  },
  {
    id: 'system',
    title: 'System and hardware',
    rows: [
      {
        id: 'back',
        label: 'Back',
        commands: ['back'],
        link: docs('commands', 'navigation'),
      },
      {
        id: 'home',
        label: 'Home',
        commands: ['home'],
        link: docs('commands', 'navigation'),
      },
      {
        id: 'orientation',
        label: 'Set screen orientation',
        commands: ['orientation'],
        link: docs('commands', 'navigation'),
        cells: {
          'ios-sim': {
            text: 'Set only; unlock unsupported',
            admits: ['setOrientation'],
            refuses: ['unlockOrientation'],
          },
          'ios-device': {
            text: 'Set only; unlock unsupported',
            admits: ['setOrientation'],
            refuses: ['unlockOrientation'],
          },
          'browserstack-android': {
            text: 'Set only; unlock unsupported',
            admits: ['setOrientation'],
            refuses: ['unlockOrientation'],
          },
          'browserstack-ios': {
            text: 'Set only; unlock unsupported',
            admits: ['setOrientation'],
            refuses: ['unlockOrientation'],
          },
          'aws-device-farm-android': {
            text: 'Set only; unlock unsupported',
            admits: ['setOrientation'],
            refuses: ['unlockOrientation'],
          },
          'aws-device-farm-ios': {
            text: 'Set only; unlock unsupported',
            admits: ['setOrientation'],
            refuses: ['unlockOrientation'],
          },
          'limrun-ios': {
            text: 'Set only; unlock unsupported',
            admits: ['setOrientation'],
            refuses: ['unlockOrientation'],
          },
        },
      },
      {
        id: 'hardware-buttons',
        label: 'Phone hardware buttons',
        commands: ['hardware-button'],
        link: docs('commands', 'navigation'),
        note: 'Each button is a separate operation; a target that answers the row still refuses buttons it does not model.',
        cells: {
          'ios-device': {
            text: 'Volume only',
            admits: ['volumeUp', 'volumeDown'],
            refuses: [
              'power',
              'mute',
              'sleep',
              'wake',
              'mediaPlayPause',
              'mediaNext',
              'mediaPrevious',
              'mediaRewind',
              'mediaFastForward',
            ],
          },
        },
      },
      {
        id: 'action-button',
        label: 'iPhone Action Button',
        commands: ['action-button'],
        link: docs('commands', 'navigation'),
        cells: {
          'ios-sim': {
            text: 'Models with an Action Button only',
          },
          'ios-device': {
            text: 'Models with an Action Button only',
          },
        },
      },
      {
        id: 'fold',
        label: 'Foldable pose',
        commands: ['fold'],
        link: docs('commands', 'navigation'),
        cells: {
          'ios-sim': {
            text: 'Foldable models only',
          },
          'android-emulator': {
            text: 'Foldable models only',
          },
          'android-tv-emulator': {
            text: 'Foldable models only',
          },
        },
      },
      {
        id: 'tv-remote',
        label: 'TV remote keys',
        commands: ['tv-remote'],
        link: docs('commands', 'tv-targets'),
      },
      {
        id: 'settings',
        label: 'System and app settings helpers',
        commands: ['settings'],
        link: docs('commands', 'settings-helpers'),
        note: 'Each helper admits on its own, and a target may run only a subset of the helpers.',
        cells: {
          'tvos-sim': {
            text: 'Set only; no reads',
            admits: ['setSetting'],
            refuses: ['readSetting'],
          },
          'macos-desktop': {
            text: 'Set only; no reads',
            admits: ['setSetting'],
            refuses: ['readSetting'],
          },
          'harmonyos-emulator': {
            text: 'Clear app state only; other settings and reads unsupported',
            admits: ['setSetting'],
            refuses: ['readSetting'],
          },
          'harmonyos-device': {
            text: 'Clear app state only; other settings and reads unsupported',
            admits: ['setSetting'],
            refuses: ['readSetting'],
          },
          'limrun-ios': {
            text: 'Set only; no reads',
            admits: ['setSetting'],
            refuses: ['readSetting'],
          },
        },
      },
      {
        id: 'clipboard',
        label: 'Clipboard read and write',
        commands: ['clipboard'],
        link: docs('commands', 'clipboard'),
        note: 'A **Yes** means the target exposes clipboard automation. Android depends on the build: AOSP clipboard services from `android13-release` through `android16-release` have no `cmd clipboard` implementation, so such a build refuses the commands, and on builds that answer, Android focus rules can still make a read come back blank.',
        cells: {
          'android-emulator': {
            text: 'Build-dependent; unavailable on AOSP builds without `cmd clipboard`',
            admits: ['readClipboard', 'writeClipboard'],
          },
          'android-device': {
            text: 'Build-dependent; unavailable on AOSP builds without `cmd clipboard`',
            admits: ['readClipboard', 'writeClipboard'],
          },
          'android-tv-emulator': {
            text: 'Build-dependent; unavailable on AOSP builds without `cmd clipboard`',
            admits: ['readClipboard', 'writeClipboard'],
          },
          'android-tv-device': {
            text: 'Build-dependent; unavailable on AOSP builds without `cmd clipboard`',
            admits: ['readClipboard', 'writeClipboard'],
          },
        },
      },
      {
        id: 'push',
        label: 'Push notification simulation',
        commands: ['push'],
        link: docs('commands', 'push-notification-simulation'),
      },
      {
        id: 'app-events',
        label: 'App event triggers through the app hook',
        commands: ['trigger-app-event'],
        link: docs('commands', 'app-event-triggers-app-hook'),
      },
      {
        id: 'telephony',
        label: 'Call and SMS simulation',
        commands: ['telephony'],
        link: docs('commands', 'navigation'),
      },
    ],
  },
];

/**
 * Capabilities the runtime facts do not decide: they are host tools, daemon
 * features, or flows that run wherever their device commands run. The guard
 * checks that every command named here exists in the command registry, so a
 * removed command fails this page too.
 */
export const SCOPE_ROWS: readonly ScopeRow[] = [
  {
    id: 'react-devtools-tree',
    label: 'React component tree, inspect, and errors',
    commands: ['react-devtools'],
    scope:
      'Needs a React Native or Expo development build that registers the React DevTools backend, reachable through the app Metro dev server. No React DevTools window may be connected.',
    link: docs('debugging-profiling', 'react-native-components'),
  },
  {
    id: 'react-devtools-profile',
    label: 'React render profiling',
    commands: ['react-devtools'],
    scope:
      'Needs a development build of React Native 0.74 or later and its Metro dev server. Verified on Android emulators and iOS simulators, and over `proxy` and remote bridge sessions.',
    link: docs('debugging-profiling', 'react-native-performance-profiling'),
  },
  {
    id: 'cdp',
    label: 'JavaScript heap and profiles through CDP',
    commands: ['cdp'],
    scope:
      'Needs a Metro CDP target, so it applies to React Native and Expo apps. It runs a pinned npm helper on the agent host, and the first run may download it.',
    link: docs('debugging-profiling', 'react-native-js-memory-through-cdp'),
  },
  {
    id: 'crash-symbolication',
    label: 'Crash symbolication',
    commands: ['debug'],
    scope:
      'Apple crash artifacts only (`.ips`, `.crash`, or log style), symbolicated against local `.dSYM` bundles with `atos`. Android Java and R8 mapping, and native `ndk-stack` output, are out of scope.',
    link: docs('debugging-profiling', 'crash-symbolication'),
  },
  {
    id: 'tracing',
    label: 'Native profiles and traces',
    commands: ['trace'],
    scope:
      'Use `perf cpu profile` for Apple xctrace or Android simpleperf profiles, and `perf trace` for supported Apple xctrace or Android Perfetto captures; both need a supported app session. The separate `trace` command captures session diagnostic logs.',
    link: docs('commands', 'tracing'),
  },
  {
    id: 'replay',
    label: '.ad replay scripts and the replay test runner',
    commands: ['replay', 'test'],
    scope:
      'Runs supported `.ad` actions subject to target support and replay restrictions. Some resource operations are unavailable inside bounded replay even when they work standalone.',
    link: docs('replay-e2e', 'run-replay'),
  },
  {
    id: 'batch',
    label: 'Batched command runs',
    commands: ['batch'],
    scope:
      'Runs registry-approved batch commands serially in one session. Target admission still applies, and lifecycle and resource restrictions can reject operations that work standalone.',
    link: docs('batching', 'run-a-batch-from-the-cli'),
  },
  {
    id: 'maestro',
    label: 'Maestro flow import and .ad export',
    commands: ['replay', 'test'],
    scope:
      'Runs a documented subset of Maestro YAML on iOS and Android only. Exports compatible `.ad` actions to Maestro YAML; unsupported actions and selector shapes fail with source context, and semantic differences produce warnings.',
    link: docs('run-maestro-flows', 'supported-subset'),
  },
  {
    id: 'mcp',
    label: 'MCP server',
    commands: ['mcp'],
    scope:
      'One `agent-device mcp` server per daemon exposes the device commands that mark themselves MCP-exposed, including provider sessions already connected on that daemon.',
    link: docs('agent-setup', 'mcp-server'),
  },
  {
    id: 'node-api',
    label: 'Typed Node.js API',
    commands: [],
    scope:
      'The typed client exposes device and session operations through domain methods and `client.command`. Daemon-backed methods share CLI command semantics and target restrictions; the client does not expose every CLI entry point.',
    link: docs('client-api', 'command-methods'),
  },
  {
    id: 'sessions',
    label: 'Named sessions, leases, and parallel runs',
    commands: ['devices', 'capabilities'],
    scope:
      'Sessions and leases are daemon state, so parallel runs come from separate session names, device allowlists, and worktrees rather than from the target. Two worktrees can drive two platforms from one checkout.',
    link: docs('sessions', 'drive-two-platforms-from-one-checkout'),
  },
  {
    id: 'remote-daemon',
    label: 'Remote daemon and device host',
    commands: ['connect', 'proxy'],
    scope:
      'A `proxy` between the agent machine and the device host forwards the same daemon surface, so the device rows above apply across it. Provider clouds need no proxy.',
    link: docs('remote-proxy', 'what-the-proxy-exposes'),
  },
  {
    id: 'provider-clouds',
    label: 'Hosted device providers',
    commands: ['connect', 'artifacts'],
    scope:
      'BrowserStack, AWS Device Farm, TestMu AI, Limrun, and Revyl appear as their own columns above. Provider artifact lookup after `close` works for the three WebDriver providers; Limrun and Revyl keep no artifacts.',
    link: docs('device-clouds', 'compare-providers'),
  },
  {
    id: 'frameworks',
    label: 'Native, React Native, Expo, and Flutter apps',
    commands: ['react-native'],
    scope:
      'Native and Flutter apps use the interactions and accessibility data exposed by their target. React Native and Expo development builds can additionally expose React component inspection, render profiling, and Metro CDP tools when their documented prerequisites are met.',
    link: docs('introduction', 'what-you-can-use-it-for'),
  },
];
