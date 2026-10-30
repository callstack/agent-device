import assert from 'node:assert/strict';
import { test } from 'vitest';
import { ownerFilesForCommand } from '@agent-device/command-registry/owner-files';
import { commandSupportsSettleObservation } from '@agent-device/command-registry/registry';
import { DIFF_COMMAND_OUTPUT_SCHEMAS } from './capture/diff.ts';
import { WAIT_COMMAND_OUTPUT_SCHEMAS } from './capture/wait.ts';
import { PREPARE_COMMAND_OUTPUT_SCHEMAS } from './management/prepare.ts';
import { DOCTOR_COMMAND_OUTPUT_SCHEMAS } from './management/doctor.ts';
import { DEVICE_MANAGEMENT_COMMAND_OUTPUT_SCHEMAS } from './management/device.ts';
import { PUSH_MANAGEMENT_COMMAND_OUTPUT_SCHEMAS } from './management/push.ts';
import { VIEWPORT_COMMAND_OUTPUT_SCHEMAS } from './management/viewport.ts';
import { INTERACTION_COMMAND_OUTPUT_SCHEMAS } from './interaction/index.ts';
import { RECORDING_COMMAND_OUTPUT_SCHEMAS } from './recording/output-schemas.ts';
import { REPLAY_COMMAND_OUTPUT_SCHEMAS } from './replay/index.ts';
import { SYSTEM_COMMAND_OUTPUT_SCHEMAS } from './system/index.ts';
import { COMMAND_OUTPUT_SCHEMAS } from './command-output-schemas.ts';
import type { JsonSchema } from './command-contract.ts';

test('MCP replay family output schemas are the family module entries, not copies', () => {
  assert.equal(COMMAND_OUTPUT_SCHEMAS.replay, REPLAY_COMMAND_OUTPUT_SCHEMAS.replay);
  assert.equal(COMMAND_OUTPUT_SCHEMAS.test, REPLAY_COMMAND_OUTPUT_SCHEMAS.test);
});

test('the projected family map declares exactly the commands its module owns', () => {
  const commands = Object.keys(REPLAY_COMMAND_OUTPUT_SCHEMAS) as ['replay', 'test'];
  assert.deepEqual(commands, ['replay', 'test']);
  for (const command of commands) {
    assert.ok(
      ownerFilesForCommand(command).includes('packages/command-surface/src/replay/index.ts'),
      `${command} projects its output schema from this module but does not name it as its owner`,
    );
  }
});

/**
 * A projected family is spread into the base map, so two families naming one command would resolve
 * last-wins with nothing to complain about: the composed map still satisfies
 * `Record<keyof CommandResultMap, JsonSchema>` and publishes whichever schema spread last. Totality
 * stays the compiler's; this owns the shadowing half. Every family the seam spreads is listed here,
 * so registering a new family is the migration step.
 */
const PROJECTED_FAMILIES = [
  { name: 'replay', schemas: REPLAY_COMMAND_OUTPUT_SCHEMAS },
  { name: 'system', schemas: SYSTEM_COMMAND_OUTPUT_SCHEMAS },
  { name: 'interaction', schemas: INTERACTION_COMMAND_OUTPUT_SCHEMAS },
  { name: 'capture-diff', schemas: DIFF_COMMAND_OUTPUT_SCHEMAS },
  { name: 'capture-wait', schemas: WAIT_COMMAND_OUTPUT_SCHEMAS },
  { name: 'management-prepare', schemas: PREPARE_COMMAND_OUTPUT_SCHEMAS },
  { name: 'management-doctor', schemas: DOCTOR_COMMAND_OUTPUT_SCHEMAS },
  { name: 'management-device', schemas: DEVICE_MANAGEMENT_COMMAND_OUTPUT_SCHEMAS },
  { name: 'management-push', schemas: PUSH_MANAGEMENT_COMMAND_OUTPUT_SCHEMAS },
  { name: 'management-viewport', schemas: VIEWPORT_COMMAND_OUTPUT_SCHEMAS },
  { name: 'recording', schemas: RECORDING_COMMAND_OUTPUT_SCHEMAS },
] as const;

function assertSettleGrafted(published: JsonSchema, base: JsonSchema, command: string): void {
  if (base.oneOf) {
    assert.equal(published.oneOf?.length, base.oneOf.length, `${command} branches changed`);
    base.oneOf.forEach((branch, index) =>
      assertSettleGrafted(published.oneOf![index]!, branch, command),
    );
  } else {
    assert.ok(published.properties?.settle, `${command} lacks settle`);
  }
}

test('projected output-schema families claim disjoint commands and survive the composition intact', () => {
  const claimedBy = new Map<string, string>();
  for (const family of PROJECTED_FAMILIES) {
    for (const command of Object.keys(family.schemas)) {
      const previous = claimedBy.get(command);
      assert.equal(
        previous,
        undefined,
        `${command} is claimed by both ${previous} and ${family.name}; the later spread would win silently`,
      );
      claimedBy.set(command, family.name);
    }
  }
  for (const family of PROJECTED_FAMILIES) {
    for (const [command, schema] of Object.entries(family.schemas)) {
      const published = COMMAND_OUTPUT_SCHEMAS[command as keyof typeof COMMAND_OUTPUT_SCHEMAS];
      // A command with the post-action observation trait (#1652) is grafted onto a COPY by
      // deriveSettleObservationSchemas, so it is deliberately not reference-equal here; a
      // trait-free command must survive the spread untouched.
      if (commandSupportsSettleObservation(command)) {
        assert.notEqual(
          published,
          schema,
          `${family.name}.${command} carries the settle trait but was not copied by the derivation pass`,
        );
        assertSettleGrafted(published, schema, `${family.name}.${command}`);
      } else {
        assert.equal(
          published,
          schema,
          `${family.name}.${command} is not the schema the map publishes`,
        );
      }
    }
  }
});
