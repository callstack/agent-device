import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  parseUiHierarchyTree,
  buildUiHierarchySnapshot,
} from '../../platform-android/src/ui-hierarchy.ts';
import { buildAndroidSnapshotClickabilityEvidence } from '../../platform-android/src/snapshot-clickability.ts';
import {
  createAndroidSnapshotCapture,
  androidSnapshotPublicationInput,
} from '../../platform-android/src/snapshot-capture.ts';
import { readSnapshotClickabilityEvidence } from '../../contracts/src/snapshot-private-evidence.ts';
import { createReplayBackendHost } from '../../replay-port/src/daemon-port/replay-backend-host.ts';

const [plugin, scratch] = process.argv.slice(2);
const { default: maestroPlugin } = await import(
  pathToFileURL(path.join(plugin, 'dist/agent-device.mjs'))
);
const target = 'maestro-clickable-first-target';
const setup = maestroPlugin().contributes[0].setup();
const host = {
  ...createReplayBackendHost(),
  resolveTargetDevice: () => {
    throw new Error('explicit platform must not discover devices');
  },
  buildActionFailureResponse: (failure) => {
    throw new Error(JSON.stringify(failure.error));
  },
};
const backend = await setup.replayBackend.create(host);

try {
  for (const indexed of [false, true]) {
    let selection = 'none';
    const points = [];
    const expectedPoint = indexed ? [20, 20] : [20, 80];
    const expectedSelection = indexed ? 'inert' : 'clickable';
    const entry = path.join(scratch, `clickability-${indexed}.yaml`);
    const source = `appId: com.example.app\n---\n- tapOn:\n    id: ${target}\n${indexed ? '    index: 0\n' : ''}- assertVisible:\n    text: "Maestro selection: ${expectedSelection}"\n`;
    const capture = () => {
      const xml = `<hierarchy rotation="0"><node class="android.widget.TextView" text="Inert duplicate target" resource-id="${target}" clickable="false" enabled="true" visible-to-user="true" bounds="[0,0][40,40]"/><node class="android.widget.Button" text="Clickable duplicate target" resource-id="${target}" clickable="true" enabled="true" visible-to-user="true" bounds="[0,60][40,100]"/><node class="android.widget.TextView" text="Maestro selection: ${selection}" clickable="false" enabled="true" visible-to-user="true" bounds="[0,120][200,160]"/></hierarchy>`;
      const built = buildUiHierarchySnapshot(parseUiHierarchyTree(xml), undefined, {});
      const { sourceNodes: _sourceNodes, occlusionContext, ...snapshot } = built;
      const data = androidSnapshotPublicationInput(
        createAndroidSnapshotCapture(
          { ...snapshot, createdAt: Date.now(), androidSnapshot: {} },
          { clickability: buildAndroidSnapshotClickabilityEvidence(built), occlusionContext },
        ),
      );
      assert.equal(readSnapshotClickabilityEvidence(data)?.kind, 'exact');
      assert.ok(data.nodes.every((node) => !Object.hasOwn(node, 'clickable')));
      return data;
    };
    const result = await backend.runReplay({
      request: {
        command: 'replay',
        positionals: [entry],
        flags: {
          platform: 'android',
          replayBackend: 'maestro',
          replayScriptSource: { entry, files: { [entry]: source } },
        },
      },
      host: { env: {}, cwd: scratch },
      session: {
        name: 'packed-clickability',
        logPath: path.join(scratch, 'clickability.log'),
        store: {
          get: () => undefined,
          lookup: () => undefined,
          resolveOpenRuntimeHints: () => undefined,
        },
      },
      invoke: async (request) => {
        if (request.command === 'snapshot') return { ok: true, data: capture() };
        if (request.command === 'runtime')
          return { ok: true, data: { viewport: { x: 0, y: 0, width: 200, height: 200 } } };
        if (request.command === 'click') {
          const point = request.positionals.map(Number);
          points.push(point);
          assert.deepEqual(
            point,
            expectedPoint,
            indexed
              ? 'explicit index must retain source order'
              : 'no-index Maestro must select the clickable duplicate',
          );
          selection = point[1] < 40 ? 'inert' : 'clickable';
          return { ok: true, data: {} };
        }
        throw new Error(`unexpected native boundary command: ${request.command}`);
      },
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.data.replayed, 2);
    assert.deepEqual(points, [expectedPoint]);
  }
  console.log('packed clickability: no-index and explicit-index contracts passed');
} finally {
  await setup.dispose();
}
