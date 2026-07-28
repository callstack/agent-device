/**
 * Typed result consumption from `agent-device/contracts`: compute the center
 * point of a snapshot node's rect, using the same `centerOfRect` helper the
 * daemon and CLI use internally.
 *
 * Demonstrates: `centerOfRect` from `agent-device/contracts`, consumed
 * against the `CaptureSnapshotResult` shape returned by the root client.
 *
 * Prerequisites: an `agent-device` daemon target with an app already open.
 * This file typechecks without one.
 *
 * Run: node --experimental-strip-types examples/sdk/contracts-result.ts
 */
import { createAgentDeviceClient } from 'agent-device';
import { centerOfRect } from 'agent-device/contracts';

function assertHasRect<T extends { rect?: unknown }>(
  node: T | undefined,
): asserts node is T & { rect: NonNullable<T['rect']> } {
  if (!node?.rect) {
    throw new Error('No visible node with a rect in the snapshot');
  }
}

async function main(): Promise<void> {
  const client = createAgentDeviceClient({ session: 'sdk-example' });

  try {
    const snapshot = await client.capture.snapshot({ interactiveOnly: true });
    const node = snapshot.nodes.find((candidate) => candidate.rect !== undefined);
    assertHasRect(node);

    const center = centerOfRect(node.rect);
    console.log(
      `center of ${node.role ?? 'node'} "${node.label ?? node.ref}": (${center.x}, ${center.y})`,
    );
  } finally {
    await client.sessions.close();
  }
}

await main();
