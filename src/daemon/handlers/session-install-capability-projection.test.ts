import { expect, test } from 'vitest';
import { INTERNAL_COMMANDS, PUBLIC_COMMANDS } from '../../command-catalog.ts';
import { commandDescriptors } from '../../core/command-descriptor/registry.ts';
import { installFamilyCapabilityAvailable } from './session-install-capability-projection.ts';

test('keeps the facts-only capability projection narrow to the install family', () => {
  const projectedCommands = commandDescriptors
    .filter((descriptor) => descriptor.catalog.group === 'public')
    .map((descriptor) => descriptor.name)
    .filter((command) => installFamilyCapabilityAvailable(command, undefined) !== undefined)
    .sort();

  expect(projectedCommands).toEqual(
    [
      PUBLIC_COMMANDS.install,
      PUBLIC_COMMANDS.reinstall,
      PUBLIC_COMMANDS.installFromSource,
      PUBLIC_COMMANDS.push,
    ].sort(),
  );
});

test('guards the public source-install alias against descriptor-use drift', () => {
  expect(runtimeUse(PUBLIC_COMMANDS.installFromSource)).toEqual({
    required: ['ensureReady', 'materializeAppSource', 'deployMaterializedApp'],
    preferred: [],
  });
  expect(runtimeUse(PUBLIC_COMMANDS.installFromSource)).toEqual(
    runtimeUse(INTERNAL_COMMANDS.installSource),
  );
  expect(runtimeUse(PUBLIC_COMMANDS.install)).toEqual({
    required: ['deployApp'],
    preferred: [],
  });
  expect(runtimeUse(PUBLIC_COMMANDS.reinstall)).toEqual({
    required: ['deployApp'],
    preferred: [],
  });
  expect(runtimeUse(PUBLIC_COMMANDS.push)).toEqual({
    required: ['ensureReady', 'sendPushNotification'],
    preferred: [],
  });
});

function runtimeUse(command: string) {
  const execution = commandDescriptors.find(
    (descriptor) => descriptor.name === command,
  )?.platformExecution;
  if (execution?.kind !== 'device-runtime' || !('use' in execution)) {
    throw new Error(`Expected ${command} to declare one exact device-runtime use`);
  }
  return execution.use;
}
