import type {
  FillCommandResult,
  LongPressCommandResult,
  PressCommandResult,
} from '../../contracts/interaction.ts';
import type { BootCommandResult, ShutdownCommandResult } from '../../contracts/device.ts';
import type { ViewportCommandResult } from '../../contracts/viewport.ts';
import type {
  AppSwitcherCommandResult,
  BackCommandResult,
  HomeCommandResult,
  RotateCommandResult,
  TvRemoteCommandResult,
} from '../../contracts/navigation.ts';
import type { ClipboardCommandResult } from '../../contracts/clipboard.ts';
import type { AppStateCommandResult } from '../../contracts/app-state.ts';
import type { KeyboardCommandResult } from '../../contracts/keyboard.ts';

/**
 * The additive typed-result spine (ADR-0008, Phase 1 step 6).
 *
 * Maps a command name to the per-command result type from `src/contracts/*`. It
 * is SEEDED, not exhaustive: a command is listed here only once its accurate,
 * closed result shape lives in the contracts layer. Commands whose daemon
 * handler spreads dynamic/Record data (screenshot overlays, gesture
 * visualization, perf, logs, …) are deliberately omitted rather than given an
 * invented shape.
 *
 * Batches 1-2 wired `boot` / `shutdown` / `viewport` and the navigation/action
 * commands `home` / `back` / `rotate` / `app-switcher` alongside the seed
 * interaction trio. Batch 3 adds `clipboard` (a closed `read`/`write` union) and
 * `appstate` (a closed `platform` union — Apple session state with the iOS-only
 * device locators, or Android package/activity). Batch 4 adds `keyboard` (a
 * closed flat shape). Each entry is grounded in a
 * re-read of the handler's literal return; see the per-type docstrings.
 */
export interface CommandResultMap {
  press: PressCommandResult;
  fill: FillCommandResult;
  longpress: LongPressCommandResult;
  boot: BootCommandResult;
  shutdown: ShutdownCommandResult;
  viewport: ViewportCommandResult;
  home: HomeCommandResult;
  back: BackCommandResult;
  rotate: RotateCommandResult;
  'app-switcher': AppSwitcherCommandResult;
  clipboard: ClipboardCommandResult;
  appstate: AppStateCommandResult;
  keyboard: KeyboardCommandResult;
  'tv-remote': TvRemoteCommandResult;
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
