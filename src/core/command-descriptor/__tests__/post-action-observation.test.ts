import { test } from 'vitest';
import assert from 'node:assert/strict';
import { PUBLIC_COMMANDS } from '../../../command-catalog.ts';
import { findCommandMetadata } from '../../../commands/command-metadata.ts';
import { getCliCommandSchema } from '../../../cli-schema/command-schema.ts';
import {
  commandDescriptors,
  commandSupportsSettleObservation,
  commandSupportsVerifyEvidence,
  resolveCommandPostActionObservationSupport,
} from '../registry.ts';

const SETTLE_OBSERVATION_COMMANDS = [
  PUBLIC_COMMANDS.click,
  PUBLIC_COMMANDS.fill,
  PUBLIC_COMMANDS.longPress,
  PUBLIC_COMMANDS.hover,
  PUBLIC_COMMANDS.press,
  PUBLIC_COMMANDS.scroll,
  PUBLIC_COMMANDS.back,
] as const;

test('post-action observation descriptor traits are the source for settle command support', () => {
  const descriptorCommands = commandDescriptors
    .filter(
      (descriptor) => resolveCommandPostActionObservationSupport(descriptor.name) !== undefined,
    )
    .map((descriptor) => descriptor.name)
    .sort();
  assert.deepEqual(descriptorCommands, [...SETTLE_OBSERVATION_COMMANDS].sort());

  assert.equal(resolveCommandPostActionObservationSupport('click'), 'settle-and-verify');
  assert.equal(resolveCommandPostActionObservationSupport('press'), 'settle-and-verify');
  assert.equal(resolveCommandPostActionObservationSupport('fill'), 'settle-and-verify');
  assert.equal(resolveCommandPostActionObservationSupport('longpress'), 'settle');
  assert.equal(commandSupportsVerifyEvidence('longpress'), false);
  // #1783: hover reveals UI instead of activating a target, so the settled
  // diff is the observation and there is no --verify digest.
  assert.equal(resolveCommandPostActionObservationSupport('hover'), 'settle');
  assert.equal(commandSupportsVerifyEvidence('hover'), false);
  // #1638: the generic-route pair resolves no element, so there is nothing to
  // digest into --verify evidence — the settled diff IS the observation.
  assert.equal(resolveCommandPostActionObservationSupport('scroll'), 'settle');
  assert.equal(resolveCommandPostActionObservationSupport('back'), 'settle');
  assert.equal(commandSupportsVerifyEvidence('scroll'), false);
  assert.equal(commandSupportsVerifyEvidence('back'), false);
});

test('post-action observation CLI flags follow descriptor traits', () => {
  for (const command of SETTLE_OBSERVATION_COMMANDS) {
    const schema = getCliCommandSchema(command);
    const allowedFlags = new Set(schema.allowedFlags ?? []);
    assert.equal(allowedFlags.has('settle'), true, `${command}: missing --settle`);
    assert.equal(allowedFlags.has('settleQuietMs'), true, `${command}: missing --settle-quiet`);
    assert.equal(allowedFlags.has('timeoutMs'), true, `${command}: missing settle --timeout`);
    assert.equal(
      allowedFlags.has('verify'),
      commandSupportsVerifyEvidence(command),
      `${command}: verify flag must match descriptor trait`,
    );
  }
});

test('post-action observation metadata fields follow descriptor traits', () => {
  for (const descriptor of commandDescriptors) {
    const metadata = findCommandMetadata(descriptor.name);
    if (!metadata) continue;
    const properties = metadata.inputSchema.properties ?? {};
    assert.equal(
      Object.hasOwn(properties, 'settle'),
      commandSupportsSettleObservation(descriptor.name),
      `${descriptor.name}: settle field must match descriptor trait`,
    );
    assert.equal(
      Object.hasOwn(properties, 'verify'),
      commandSupportsVerifyEvidence(descriptor.name),
      `${descriptor.name}: verify field must match descriptor trait`,
    );
  }
});
