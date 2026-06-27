import { expect, test } from 'vitest';
import type {
  FillCommandResult,
  LongPressCommandResult,
  PressCommandResult,
} from '../../../contracts/interaction.ts';
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
  const press: Equal<CommandResult<'press'>, PressCommandResult> = true;
  const fill: Equal<CommandResult<'fill'>, FillCommandResult> = true;
  const longPress: Equal<CommandResult<'longpress'>, LongPressCommandResult> = true;
  expect([press, fill, longPress]).toEqual([true, true, true]);
});

test('unmigrated commands fall back to the untyped Record bag, keeping the union total', () => {
  const unknown: Equal<CommandResult<'__unmigrated__'>, Record<string, unknown>> = true;
  // A seeded name narrows away from the bare Record bag.
  const seededIsNotRecord: Equal<CommandResult<'press'>, Record<string, unknown>> = false;
  expect([unknown, seededIsNotRecord]).toEqual([true, false]);
});

test('CommandResultMap is seeded only from already-existing contract result types', () => {
  const keys: Equal<keyof CommandResultMap, 'press' | 'fill' | 'longpress'> = true;
  expect(keys).toBe(true);
});
