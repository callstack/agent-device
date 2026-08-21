import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { assertPersistentAndroidHelper, assertWaitText } from './live-assertions.ts';
import { type LiveContext, runStep, verifyBehavior } from './live-harness.ts';

const TARGET_ID = 'maestro-clickable-first-target';

export async function assertMaestroClickableFirst(context: LiveContext): Promise<void> {
  await runStep(context, 'reveal duplicate Maestro targets', ['scroll', 'down', '0.3']);
  const snapshot = await runStep(
    context,
    'capture duplicate Maestro targets through Android helper',
    ['snapshot', '-i'],
  );
  assertPersistentAndroidHelper(snapshot);

  const nodes = snapshot.json?.data?.nodes;
  assert.ok(Array.isArray(nodes), JSON.stringify(snapshot.json));
  const matchingNodes = nodes.filter(
    (node: unknown) =>
      isSnapshotNode(node) &&
      (node.identifier === TARGET_ID || node.identifier.endsWith(`:id/${TARGET_ID}`)),
  );
  assert.equal(
    matchingNodes.length,
    2,
    `expected two ${TARGET_ID} nodes from one helper snapshot: ${JSON.stringify(snapshot.json)}`,
  );
  for (const node of matchingNodes) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(node, 'clickable'),
      false,
      `clickability must stay off the public snapshot wire: ${JSON.stringify(node)}`,
    );
  }

  const flowPath = path.join(context.artifactDir, 'maestro-clickable-first.yaml');
  fs.writeFileSync(
    flowPath,
    `appId: ${JSON.stringify(context.appId)}
name: Android clickable-first selector
---
- tapOn:
    id: ${TARGET_ID}
- assertVisible:
    text: "Maestro selection: clickable"
`,
  );
  const replay = await runStep(context, 'resolve duplicate target through no-index Maestro tapOn', [
    'replay',
    flowPath,
    '--maestro',
  ]);
  assert.equal(replay.json?.data?.replayed, 2, JSON.stringify(replay.json));
  await assertWaitText(context, 'Maestro selection: clickable');
  verifyBehavior(
    context,
    'maestro-clickable-first-selection',
    'one Android helper snapshot exposed two identical resource-id nodes and a no-index Maestro tapOn selected the clickable duplicate first',
  );
}

function isSnapshotNode(value: unknown): value is { identifier: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { identifier?: unknown }).identifier === 'string'
  );
}
