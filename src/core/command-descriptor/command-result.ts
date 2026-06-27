import type {
  FillCommandResult,
  LongPressCommandResult,
  PressCommandResult,
} from '../../contracts/interaction.ts';

/**
 * The additive typed-result spine (ADR-0008, Phase 1 step 6).
 *
 * Maps a command name to the *already-existing* per-command result type from
 * `src/contracts/*`. It is SEEDED, not exhaustive: only commands whose accurate
 * result shape already lives in the contracts layer are listed here. Today that
 * is the interaction trio (`press` / `fill` / `longpress`); screenshot, perf,
 * logs and friends have no contracts-layer result type yet, so they are
 * deliberately omitted rather than given an invented shape.
 *
 * This map is dormant: nothing reads it yet. It exists as the foundation that
 * later slices consume to derive `client-types.ts` and delete the hand-authored
 * `*Result` mirror — the same dormant-but-proven pattern as the #906 descriptor
 * registry and the #910 dispatch map this slice is stacked on.
 */
export interface CommandResultMap {
  press: PressCommandResult;
  fill: FillCommandResult;
  longpress: LongPressCommandResult;
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
