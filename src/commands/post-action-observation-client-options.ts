import type {
  ClickOptions,
  FillOptions,
  HoverOptions,
  LongPressOptions,
  PressOptions,
  ScrollOptions,
  SettleCommandOptions,
} from '@agent-device/contracts/client';
import type { PostActionObservationCommandName } from '../core/command-descriptor/post-action-observation.ts';
import type { NavigationCommandOptions } from './system/navigation-projection.ts';

/**
 * Compile-time completeness for the contracts half of the `--settle` surface
 * (#1652): every client options type whose command carries the descriptor
 * post-action observation trait must intersect `SettleCommandOptions`.
 *
 * The `Record` over the trait command union makes a missing or extra cell a
 * compile error, and the `satisfies` assignability check fails when any listed
 * option type drops its `& SettleCommandOptions` intersection — the same
 * strategy `packages/contracts/src/interaction-guarantees.ts` uses to make
 * guarantee completeness a compile error instead of a runtime assertion.
 */
const SETTLE_CAPABLE_CLIENT_OPTION_TYPES = {
  click: {} as ClickOptions,
  press: {} as PressOptions,
  longpress: {} as LongPressOptions,
  hover: {} as HoverOptions,
  fill: {} as FillOptions,
  scroll: {} as ScrollOptions,
  back: {} as NavigationCommandOptions<'back'>,
} as const satisfies Record<PostActionObservationCommandName, SettleCommandOptions>;

export type SettleCapableClientOptionCommands =
  readonly (keyof typeof SETTLE_CAPABLE_CLIENT_OPTION_TYPES)[];
