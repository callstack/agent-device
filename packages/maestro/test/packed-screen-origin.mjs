import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createIosSnapshotAcquisition } from '../../capture-kit/src/ios-snapshot-acquisition.ts';
import { presentIosSnapshotAcquisition } from '../../capture-kit/src/snapshot/ios-snapshot-runtime.ts';
import { buildSnapshotState } from '../../capture-kit/src/snapshot-state.ts';
import { createReplayBackendHost } from '../../replay-port/src/daemon-port/replay-backend-host.ts';

const [plugin, scratch] = process.argv.slice(2);
const { default: maestroPlugin } = await import(
  pathToFileURL(path.join(plugin, 'dist/agent-device.mjs'))
);
const setup = maestroPlugin().setup();
const backend = await setup.replayBackend.create({
  ...createReplayBackendHost(),
  resolveTargetDevice: () => {
    throw new Error('explicit platform must not discover devices');
  },
  buildActionFailureResponse: async ({ error }) => ({ ok: false, error }),
});
const rect = { x: 0, y: 0, width: 390, height: 844 };

try {
  for (const kind of ['derived', 'missing', 'reported']) {
    for (const action of ['tap', 'scroll']) {
      let dispatched = false;
      const requests = [];
      const nodes = [
        { index: 0, type: 'Application', rect },
        { index: 1, parentIndex: 0, type: 'ScrollView', identifier: 'container', rect },
        {
          index: 2,
          parentIndex: 1,
          type: 'Button',
          identifier: 'action',
          label: 'Action',
          rect: { x: 100, y: 100, width: 80, height: 40 },
        },
      ];
      const entry = path.join(scratch, `screen-origin-${kind}-${action}.yaml`);
      const source = `appId: com.example.app\n---\n${action === 'tap' ? '- tapOn:\n    id: action\n    index: 0\n' : '- scrollUntilVisible:\n    element: Found\n    direction: DOWN\n    timeout: 1000\n'}`;
      const result = await backend.runReplay({
        request: {
          command: 'replay',
          positionals: [entry],
          flags: {
            platform: 'ios',
            replayBackend: 'maestro',
            replayScriptSource: { entry, files: { [entry]: source } },
          },
        },
        host: { env: {}, cwd: scratch },
        session: {
          name: 'packed-screen-origin',
          logPath: path.join(scratch, 'screen-origin.log'),
          store: {
            get: () => undefined,
            lookup: () => undefined,
            resolveOpenRuntimeHints: () => undefined,
          },
        },
        invoke: async (request) => {
          requests.push(request);
          if (request.command === 'snapshot') {
            const acquisition = createIosSnapshotAcquisition({
              producer: 'appium-source',
              nodes: dispatched
                ? [...nodes, { index: 3, parentIndex: 1, type: 'StaticText', label: 'Found', rect }]
                : nodes,
              viewport: kind === 'missing' ? { kind, reason: 'not-provided' } : { kind, rect },
              lineage: { targetId: 'ios-origin:com.example.app' },
            });
            return {
              ok: true,
              data: buildSnapshotState(presentIosSnapshotAcquisition(acquisition, { raw: true }), {
                snapshotRaw: true,
              }),
            };
          }
          if (request.command === 'runtime') return { ok: true, data: { viewport: rect } };
          if (request.command === 'click' || request.command === 'gesture') {
            dispatched = true;
            return { ok: true, data: {} };
          }
          throw new Error(`unexpected native boundary command: ${request.command}`);
        },
      });
      if (kind === 'reported') {
        assert.equal(result.ok, true, JSON.stringify(result));
        assert.equal(result.data.replayed, 1);
        assert.equal(dispatched, true, `${action} must dispatch with reported origin`);
        const input = requests.find(
          ({ command }) => command === (action === 'tap' ? 'click' : 'gesture'),
        );
        assert.ok(input);
        if (action === 'tap') assert.deepEqual(input.positionals, ['140', '120']);
      } else {
        assert.equal(dispatched, false, `${kind} ${action} must refuse before input`);
        assert.equal(result.ok, false);
        assert.equal(result.error.details.reason, 'window-origin-unknown');
        assert.equal(result.error.details.dispatched, 'no');
      }
    }
  }
  console.log('packed screen origin: derived/missing refusal and reported tap/scroll passed');
} finally {
  await setup.dispose();
}
