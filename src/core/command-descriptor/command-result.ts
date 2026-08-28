import type {
  DiffSnapshotCommandResult,
  ViewportCommandResult,
} from '@agent-device/contracts/capture';
import type { PrepareCommandResult, PushCommandResult } from '@agent-device/contracts/command';
import type {
  AppStateCommandResult,
  BootCommandResult,
  ShutdownCommandResult,
  TriggerAppEventCommandResult,
} from '@agent-device/contracts/device';
import type {
  AppSwitcherCommandResult,
  BackCommandResult,
  HomeCommandResult,
  OrientationCommandResult,
  TvRemoteCommandResult,
} from '@agent-device/contracts/navigation';
import type {
  ClickCommandResponseData,
  FillCommandResponseData,
  FindCommandResponseData,
  HoverCommandResponseData,
  LongPressCommandResponseData,
  PressCommandResponseData,
} from '@agent-device/contracts/interaction';
import type { ClipboardCommandResult } from '@agent-device/contracts/clipboard';
import type { KeyboardCommandResult } from '@agent-device/contracts/keyboard';
import type { ScrollCommandResult } from '@agent-device/contracts/scroll-command';
import type { WaitCommandResult } from '@agent-device/contracts/wait';
import type { DoctorCommandResult } from '@agent-device/contracts/observability';
import type { RecordingCommandResult, TraceCommandResult } from '@agent-device/contracts/recording';
import type { ReplayCommandResult, ReplaySuiteResult } from '@agent-device/contracts/replay';

/**
 * The additive typed-result spine (ADR-0008, Phase 1 step 6).
 *
 * Maps a command name to the per-command result type from `@agent-device/contracts`. It
 * is SEEDED, not exhaustive: a command is listed here only once its accurate,
 * closed result shape lives in the contracts layer. Commands whose daemon
 * handler spreads dynamic/Record data (screenshot overlays, gesture
 * visualization, perf, logs, …) are deliberately omitted rather than given an
 * invented shape.
 *
 * Batches 1-2 wired `boot` / `shutdown` / `viewport` and the navigation/action
 * commands `home` / `back` / `orientation` / `app-switcher` alongside the seed
 * interaction quartet. Batch 3 adds `clipboard` (a closed `read`/`write` union) and
 * `appstate` (a closed `platform` union — Apple session state with the iOS-only
 * device locators, or Android package/activity). Batch 4 adds `keyboard` (a
 * closed flat shape). Batch 5 adds the compact daemon projections for `wait`,
 * `prepare`, `push`, and `trigger-app-event`. #1652 adds `scroll`
 * (ScrollCommandResult): the shared dispatch vocabulary plus the opt-in
 * settle observation, so the settle-capable generic-route pair (`back`,
 * `scroll`) is fully typed and its MCP output schema derives from the trait.
 * Each entry is grounded in a
 * re-read of the handler's literal return; see the per-type docstrings.
 */
export interface CommandResultMap {
  'app-switcher': AppSwitcherCommandResult;
  appstate: AppStateCommandResult;
  back: BackCommandResult;
  boot: BootCommandResult;
  click: ClickCommandResponseData;
  clipboard: ClipboardCommandResult;
  diff: DiffSnapshotCommandResult;
  doctor: DoctorCommandResult;
  fill: FillCommandResponseData;
  find: FindCommandResponseData;
  home: HomeCommandResult;
  hover: HoverCommandResponseData;
  keyboard: KeyboardCommandResult;
  longpress: LongPressCommandResponseData;
  orientation: OrientationCommandResult;
  prepare: PrepareCommandResult;
  press: PressCommandResponseData;
  push: PushCommandResult;
  record: RecordingCommandResult;
  replay: ReplayCommandResult;
  scroll: ScrollCommandResult;
  shutdown: ShutdownCommandResult;
  test: ReplaySuiteResult;
  trace: TraceCommandResult;
  'trigger-app-event': TriggerAppEventCommandResult;
  'tv-remote': TvRemoteCommandResult;
  viewport: ViewportCommandResult;
  wait: WaitCommandResult;
}

/**
 * The typed result for a command named `N`. Seeded commands resolve to their
 * contract result type from {@link CommandResultMap}; every other (unmigrated)
 * command falls back to the untyped `Record<string, unknown>` bag. That default
 * branch is what keeps the mapping total over every command name, so consumers
 * can switch to `CommandResult<Name>` without first migrating every command.
 */
export type CommandResult<N extends string> = N extends keyof CommandResultMap
  ? CommandResultMap[N]
  : Record<string, unknown>;
