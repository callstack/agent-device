/**
 * Root client session: create a client, open an app, capture a snapshot, tap
 * a node, then close the session — with typed error handling via the
 * exported error helpers.
 *
 * Demonstrates: `createAgentDeviceClient`, `AppError`, `isAgentDeviceError`,
 * and `normalizeAgentDeviceError` from the `agent-device` root export.
 *
 * Prerequisites: an `agent-device` daemon target (a booted iOS simulator).
 * This file typechecks without one; running it for real also requires
 * `pnpm build` first, so the package resolves at runtime.
 *
 * Run: node --experimental-strip-types examples/sdk/client-session.ts
 */
import {
  AppError,
  createAgentDeviceClient,
  isAgentDeviceError,
  normalizeAgentDeviceError,
} from 'agent-device';

async function resolveSnapshotCapableIosDevice(client: ReturnType<typeof createAgentDeviceClient>) {
  const devices = await client.devices.list({ platform: 'ios' });
  const device = devices[0];
  if (!device) {
    throw new AppError('DEVICE_NOT_FOUND', 'No iOS device available');
  }

  const capabilities = await client.devices.capabilities({ platform: 'ios' });
  if (!capabilities.availableCommands.includes('snapshot')) {
    throw new AppError('UNSUPPORTED_OPERATION', 'Selected target does not support snapshots');
  }

  return device;
}

function reportAgentDeviceError(error: unknown): void {
  const normalized = normalizeAgentDeviceError(error);
  console.error(`agent-device error [${normalized.code}]: ${normalized.message}`);
  if (normalized.hint) {
    console.error(`hint: ${normalized.hint}`);
  }
  process.exitCode = 1;
}

async function main(): Promise<void> {
  const client = createAgentDeviceClient({
    session: 'sdk-example',
    lockPolicy: 'reject',
    lockPlatform: 'ios',
  });

  try {
    const device = await resolveSnapshotCapableIosDevice(client);

    await client.apps.open({
      app: 'com.apple.Preferences',
      platform: 'ios',
      udid: device.id,
    });

    const snapshot = await client.capture.snapshot({ interactiveOnly: true });
    const target = snapshot.nodes.find((node) => node.role === 'button');
    if (target) {
      await client.interactions.press({ ref: target.ref });
    }
  } catch (error) {
    if (!isAgentDeviceError(error)) throw error;
    reportAgentDeviceError(error);
  } finally {
    await client.sessions.close();
  }
}

await main();
