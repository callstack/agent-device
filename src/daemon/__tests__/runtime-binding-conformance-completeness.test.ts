import { expect, test } from 'vitest';
import {
  commandDescriptors,
  commandRuntimeUseRequirements,
} from '@agent-device/command-registry/registry';
import {
  conformedRuntimeBindings,
  refusedRuntimeOperation,
  refuseUnavailableExactOwnerFact,
  type ConformedRuntimeCommand,
} from './runtime-binding-conformance.ts';

/**
 * The command registry's `platformExecution` declarations are the production enumeration of
 * daemon runtime bindings: every device-runtime descriptor names the uses its route admits, and
 * `admitRuntimeOperations` is one seam with no table of its own. The generic and interaction routes
 * admit through per-command `src/daemon/<command>-runtime.ts` resolvers, so every single-use
 * descriptor on those routes owes the family its conformance entry; the other direction holds any
 * entry to a cell its descriptor actually declares.
 */
const CONFORMED_ROUTES = new Set(['generic', 'interaction']);

function singleUseConformedRouteCommands(): string[] {
  return commandDescriptors
    .filter((descriptor) => {
      const route = 'daemon' in descriptor ? descriptor.daemon?.route : undefined;
      return route !== undefined && CONFORMED_ROUTES.has(route);
    })
    .map((descriptor) => descriptor.name)
    .filter((command) => commandRuntimeUseRequirements(command)?.length === 1)
    .sort();
}

const conformedCommands = Object.keys(conformedRuntimeBindings) as ConformedRuntimeCommand[];

test('every single-use generic or interaction route descriptor has a conformance entry', () => {
  const missing = singleUseConformedRouteCommands().filter(
    (command) => !conformedCommands.includes(command as ConformedRuntimeCommand),
  );

  expect(missing).toEqual([]);
});

test('every conformance entry refuses on a cell its registry descriptor declares', () => {
  const undeclared = conformedCommands.filter((command) => {
    const declared = commandRuntimeUseRequirements(command)?.flat() ?? [];
    return !declared.includes(refusedRuntimeOperation(command));
  });

  expect(undeclared).toEqual([]);
});

const conformanceDevice = {
  id: 'runtime-binding-conformance-device',
  name: 'Pixel',
  platform: 'android',
  kind: 'emulator',
  target: 'mobile',
  booted: true,
} as const;

test.each(conformedCommands)(
  '%s refuses its unavailable declared cell before binding',
  async (command) => {
    const response = await refuseUnavailableExactOwnerFact({
      command,
      device: conformanceDevice,
      unavailable: { available: false, reason: 'owner-capability-missing' },
    });

    expect(response.error.code).toBe('UNSUPPORTED_OPERATION');
  },
);
