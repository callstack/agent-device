import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createAgentDeviceClient } from '../index.ts';
import type { DaemonResponse, ScriptDeliveryFailure } from '@agent-device/kernel/contracts';
import { createClientTransport } from '@agent-device/test-kit';

/**
 * A script version that did not reach the caller file keeps its action successful, so the typed
 * failure and its paired warning are the only disclosure that the file is stale (ADR 0016, #4564).
 * Every SDK result that can carry a script version reads both fields through
 * `readScriptDeliveryDisclosure`; this table pins each one, so a spread that stops carrying either
 * field fails here rather than quietly on one surface.
 */

const WARNING = 'The session recorded version 2, but the daemon could not save it.';

const FAILURE: ScriptDeliveryFailure = {
  reason: 'script_delivery_failed',
  cause: 'script_write_failed',
  publicationId: '0f61b0c2-6d1a-4d1f-9b7f-2a4f3a1c7d55',
  message: WARNING,
  hint: 'The file keeps the version from the last action that arrived.',
};

/** The two fields one answer carries at the top level of its payload. */
const DISCLOSURE = { warnings: [WARNING], scriptDeliveryFailure: FAILURE };

/** One SDK action whose answer can carry a script version, with the answer it reads. */
type DisclosureSurface = Readonly<{
  label: string;
  command: string;
  data: Record<string, unknown>;
  read: (client: ReturnType<typeof createAgentDeviceClient>) => Promise<unknown>;
}>;

const SURFACES: DisclosureSurface[] = [
  {
    label: 'sessions.close',
    command: 'close',
    data: { ...DISCLOSURE, savedScript: '/tmp/journey.ad' },
    read: async (client) => await client.sessions.close(),
  },
  {
    label: 'apps.close',
    command: 'close',
    data: { ...DISCLOSURE, savedScript: '/tmp/journey.ad' },
    read: async (client) => await client.apps.close(),
  },
  {
    label: 'apps.open',
    command: 'open',
    data: { ...DISCLOSURE, appBundleId: 'com.example.demo' },
    read: async (client) => await client.apps.open({ app: 'Demo' }),
  },
  {
    label: 'capture.snapshot',
    command: 'snapshot',
    data: { ...DISCLOSURE, nodes: [] },
    read: async (client) => await client.capture.snapshot(),
  },
  {
    label: 'capture.screenshot',
    command: 'screenshot',
    data: { ...DISCLOSURE, path: '/tmp/shot.png', width: 40, height: 20 },
    read: async (client) => await client.capture.screenshot(),
  },
];

function clientAnswering(command: string, data: Record<string, unknown>) {
  const setup = createClientTransport(async (req): Promise<DaemonResponse> => {
    if (req.command !== command) throw new Error(`Unexpected command: ${req.command}`);
    return { ok: true, data: { session: 'qa', ...data } };
  });
  return createAgentDeviceClient(setup.config, { transport: setup.transport });
}

for (const surface of SURFACES) {
  test(`the ${surface.label} result carries a failed script delivery`, async () => {
    const client = clientAnswering(surface.command, surface.data);

    const result = (await surface.read(client)) as Record<string, unknown>;

    assert.deepEqual(result.scriptDeliveryFailure, FAILURE, surface.label);
    assert.deepEqual(result.warnings, [WARNING], surface.label);
  });

  test(`the ${surface.label} result names no disclosure for a delivered script`, async () => {
    const plain = Object.fromEntries(
      Object.entries(surface.data).filter(
        ([key]) => key !== 'warnings' && key !== 'scriptDeliveryFailure',
      ),
    );
    const client = clientAnswering(surface.command, plain);

    const result = (await surface.read(client)) as Record<string, unknown>;

    assert.equal('scriptDeliveryFailure' in result, false, surface.label);
    assert.equal('warnings' in result, false, surface.label);
  });

  test(`the ${surface.label} result drops a malformed failure object`, async () => {
    const client = clientAnswering(surface.command, {
      ...surface.data,
      scriptDeliveryFailure: { reason: 'script_delivery_failed' },
    });

    const result = (await surface.read(client)) as Record<string, unknown>;

    assert.equal('scriptDeliveryFailure' in result, false, surface.label);
  });
}
