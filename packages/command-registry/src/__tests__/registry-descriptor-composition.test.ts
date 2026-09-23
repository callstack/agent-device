import { CAPTURE_COMMAND_DESCRIPTORS } from '../descriptors/capture.ts';
import { INTERACTION_COMMAND_DESCRIPTORS } from '../descriptors/interaction.ts';
import { INTERNAL_COMMAND_DESCRIPTORS } from '../descriptors/internal.ts';
import { LOCAL_CLI_COMMAND_DESCRIPTORS } from '../descriptors/local-cli.ts';
import { MANAGEMENT_COMMAND_DESCRIPTORS } from '../descriptors/management.ts';
import { OBSERVABILITY_COMMAND_DESCRIPTORS } from '../descriptors/observability.ts';
import { REACT_NATIVE_COMMAND_DESCRIPTORS } from '../descriptors/react-native.ts';
import { RECORDING_COMMAND_DESCRIPTORS } from '../descriptors/recording.ts';
import { REPLAY_COMMAND_DESCRIPTORS } from '../descriptors/replay.ts';
import { SYSTEM_COMMAND_DESCRIPTORS } from '../descriptors/system.ts';
import {
  commandDescriptors,
  RAW_COMMAND_DESCRIPTORS,
  type Command,
  type DescriptorCliCommandName,
} from '../registry.ts';
import { expect, test } from 'vitest';

const FAMILY_ARRAYS = [
  INTERNAL_COMMAND_DESCRIPTORS,
  MANAGEMENT_COMMAND_DESCRIPTORS,
  OBSERVABILITY_COMMAND_DESCRIPTORS,
  RECORDING_COMMAND_DESCRIPTORS,
  REPLAY_COMMAND_DESCRIPTORS,
  SYSTEM_COMMAND_DESCRIPTORS,
  CAPTURE_COMMAND_DESCRIPTORS,
  INTERACTION_COMMAND_DESCRIPTORS,
  REACT_NATIVE_COMMAND_DESCRIPTORS,
  LOCAL_CLI_COMMAND_DESCRIPTORS,
] as const;

type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type AssertTrue<T extends true> = T;

/**
 * `Command` must stay a union of command-name LITERALS. Consumers index records and tool
 * tables with it (`src/mcp/command-tools.ts`, `src/mcp/tool-ref-pins.ts`,
 * `packages/session-journal/src/session-event-action.ts`,
 * `src/__tests__/test-utils/property-arbitraries.ts`); a `Command` that widened to `string`
 * — which is what a family array that lost its `as const` produces — fails here.
 */
export type CommandUnionStaysLiteral = AssertTrue<Equal<Equal<Command, string>, false>>;
/** The CLI view narrows the same way, so a widened root union cannot hide behind it. */
export type CliCommandUnionStaysLiteral = AssertTrue<
  Equal<Equal<DescriptorCliCommandName, string>, false>
>;

test('the family arrays compose into the one descriptor list, with no gap or overlap', () => {
  const familyNames = FAMILY_ARRAYS.flat().map((descriptor) => descriptor.name);
  expect(new Set(familyNames).size).toBe(familyNames.length);
  expect(familyNames.sort()).toEqual(
    commandDescriptors.map((descriptor) => descriptor.name).sort(),
  );
  expect(RAW_COMMAND_DESCRIPTORS.length).toBe(familyNames.length);
});

test('the Command union rejects a name no descriptor declares', () => {
  // @ts-expect-error Not a declared command: Command is a literal union, not `string`.
  const notACommand: Command = 'not-a-registered-command';
  expect(commandDescriptors.some((descriptor) => descriptor.name === notACommand)).toBe(false);
});
