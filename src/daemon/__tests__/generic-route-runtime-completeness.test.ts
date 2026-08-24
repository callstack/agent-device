import { expect, test } from 'vitest';
import { commandDescriptors } from '../../core/command-descriptor/registry.ts';
import { resolveGenericRuntimeExecution } from '../generic-runtime-execution.ts';

/**
 * The generic route is the router's fallthrough: a descriptor joins it by declaring
 * `daemon.route: 'generic'`, not by being listed anywhere the dispatcher can read. R56 migrated
 * `app-switcher`, its last legacy leaf, so `resolveGenericRuntimeExecution` is now the route's
 * only execution path and `ensureGenericCommandReady` no longer carries a support gate behind it.
 * That totality is what these tests pin: a descriptor that joins the route without an arm would
 * otherwise reach the dispatcher through a `default` that refuses at request time.
 */
type RegistryDescriptor = (typeof commandDescriptors)[number];

function genericRouteDescriptors(): RegistryDescriptor[] {
  return commandDescriptors
    .filter(
      (descriptor) => ('daemon' in descriptor ? descriptor.daemon?.route : undefined) === 'generic',
    )
    .sort((left, right) => left.name.localeCompare(right.name));
}

test('every generic-route descriptor is runtime-owned', () => {
  const legacy = genericRouteDescriptors()
    .filter((descriptor) => descriptor.platformExecution.kind !== 'device-runtime')
    .map((descriptor) => descriptor.name);

  expect(legacy).toEqual([]);
});

async function reachesGenericRoutingGap(command: string): Promise<boolean> {
  // Every arm reaches admission before it can answer, and admission with no bindings throws — so a
  // throw proves the arm exists. Only the `default` answers, and it answers with the routing gap.
  try {
    const resolved = await resolveGenericRuntimeExecution({
      req: { command, token: '', positionals: [], flags: {} },
      session: { device: { id: 'device-1', platform: 'android', kind: 'device' } },
      context: { logPath: '' },
    } as unknown as Parameters<typeof resolveGenericRuntimeExecution>[0]);
    return (
      !resolved.ok &&
      resolved.response.ok === false &&
      resolved.response.error.details?.['reason'] === 'generic-route-runtime-missing'
    );
  } catch {
    return false;
  }
}

test('every generic-route descriptor has an arm in the runtime execution table', async () => {
  const missing: string[] = [];
  for (const descriptor of genericRouteDescriptors()) {
    if (await reachesGenericRoutingGap(descriptor.name)) missing.push(descriptor.name);
  }

  expect(missing).toEqual([]);
});

test('the routing gap is what an unrouted command actually reaches', async () => {
  // Without this the test above would pass for a table that had no arms at all.
  expect(await reachesGenericRoutingGap('not-a-generic-route-command')).toBe(true);
});
