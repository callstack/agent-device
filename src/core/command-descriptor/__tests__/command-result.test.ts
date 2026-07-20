import { expect, test } from 'vitest';
import type {
  FillCommandResponseData,
  LongPressCommandResponseData,
  PressCommandResponseData,
  FindCommandResponseData,
} from '../../../contracts/interaction.ts';
import type { BootCommandResult, ShutdownCommandResult } from '../../../contracts/device.ts';
import type { ViewportCommandResult } from '../../../contracts/viewport.ts';
import type {
  AppSwitcherCommandResult,
  BackCommandResult,
  HomeCommandResult,
  OrientationCommandResult,
  TvRemoteCommandResult,
} from '../../../contracts/navigation.ts';
import type { ClipboardCommandResult } from '../../../contracts/clipboard.ts';
import type { AppStateCommandResult } from '../../../contracts/app-state.ts';
import type { KeyboardCommandResult } from '../../../contracts/keyboard.ts';
import type { WaitCommandResult } from '../../../contracts/wait.ts';
import type { PrepareCommandResult } from '../../../contracts/prepare.ts';
import type { PushCommandResult } from '../../../contracts/push.ts';
import type { TriggerAppEventCommandResult } from '../../../contracts/app-events.ts';
import type { DoctorCommandResult } from '../../../contracts/doctor.ts';
import type { DiffSnapshotCommandResult } from '../../../contracts/diff.ts';
import type { RecordingCommandResult, TraceCommandResult } from '../../../contracts/recording.ts';
import type { ReplayCommandResult, ReplaySuiteResult } from '../../../contracts/replay.ts';
import type { CommandResult, CommandResultMap } from '../command-result.ts';

/**
 * Exact-equality type predicate (invariant in both `A` and `B`). A seeded
 * `CommandResult<Name>` must resolve to *exactly* its contract result type — not
 * merely a one-directional assignable supertype — so these assertions are what
 * `tsc --noEmit` enforces; the `expect`s below only keep vitest's runner green.
 */
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

test('seeded CommandResult entries resolve to their existing contract result types', () => {
  const press: Equal<CommandResult<'press'>, PressCommandResponseData> = true;
  const click: Equal<CommandResult<'click'>, PressCommandResponseData> = true;
  const fill: Equal<CommandResult<'fill'>, FillCommandResponseData> = true;
  const longPress: Equal<CommandResult<'longpress'>, LongPressCommandResponseData> = true;
  const find: Equal<CommandResult<'find'>, FindCommandResponseData> = true;
  const boot: Equal<CommandResult<'boot'>, BootCommandResult> = true;
  const shutdown: Equal<CommandResult<'shutdown'>, ShutdownCommandResult> = true;
  const viewport: Equal<CommandResult<'viewport'>, ViewportCommandResult> = true;
  const home: Equal<CommandResult<'home'>, HomeCommandResult> = true;
  const back: Equal<CommandResult<'back'>, BackCommandResult> = true;
  const orientation: Equal<CommandResult<'orientation'>, OrientationCommandResult> = true;
  const appSwitcher: Equal<CommandResult<'app-switcher'>, AppSwitcherCommandResult> = true;
  const clipboard: Equal<CommandResult<'clipboard'>, ClipboardCommandResult> = true;
  const appstate: Equal<CommandResult<'appstate'>, AppStateCommandResult> = true;
  const keyboard: Equal<CommandResult<'keyboard'>, KeyboardCommandResult> = true;
  const tvRemote: Equal<CommandResult<'tv-remote'>, TvRemoteCommandResult> = true;
  const wait: Equal<CommandResult<'wait'>, WaitCommandResult> = true;
  const prepare: Equal<CommandResult<'prepare'>, PrepareCommandResult> = true;
  const push: Equal<CommandResult<'push'>, PushCommandResult> = true;
  const triggerAppEvent: Equal<
    CommandResult<'trigger-app-event'>,
    TriggerAppEventCommandResult
  > = true;
  const doctor: Equal<CommandResult<'doctor'>, DoctorCommandResult> = true;
  const diff: Equal<CommandResult<'diff'>, DiffSnapshotCommandResult> = true;
  const replay: Equal<CommandResult<'replay'>, ReplayCommandResult> = true;
  const replayTest: Equal<CommandResult<'test'>, ReplaySuiteResult> = true;
  const record: Equal<CommandResult<'record'>, RecordingCommandResult> = true;
  const trace: Equal<CommandResult<'trace'>, TraceCommandResult> = true;
  expect([
    press,
    click,
    fill,
    longPress,
    find,
    boot,
    shutdown,
    viewport,
    home,
    back,
    orientation,
    appSwitcher,
    clipboard,
    appstate,
    keyboard,
    tvRemote,
    wait,
    prepare,
    push,
    triggerAppEvent,
    doctor,
    diff,
    replay,
    replayTest,
    record,
    trace,
  ]).toEqual([
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
  ]);
});

test('unmigrated commands fall back to the untyped Record bag, keeping the union total', () => {
  const unknown: Equal<CommandResult<'__unmigrated__'>, Record<string, unknown>> = true;
  // A seeded name narrows away from the bare Record bag.
  const seededIsNotRecord: Equal<CommandResult<'press'>, Record<string, unknown>> = false;
  expect([unknown, seededIsNotRecord]).toEqual([true, false]);
});

test('CommandResultMap is seeded only from already-existing contract result types', () => {
  const keys: Equal<
    keyof CommandResultMap,
    | 'press'
    | 'click'
    | 'fill'
    | 'longpress'
    | 'find'
    | 'boot'
    | 'shutdown'
    | 'viewport'
    | 'home'
    | 'back'
    | 'orientation'
    | 'app-switcher'
    | 'clipboard'
    | 'appstate'
    | 'keyboard'
    | 'tv-remote'
    | 'wait'
    | 'prepare'
    | 'push'
    | 'trigger-app-event'
    | 'doctor'
    | 'diff'
    | 'replay'
    | 'test'
    | 'record'
    | 'trace'
  > = true;
  expect(keys).toBe(true);
});
