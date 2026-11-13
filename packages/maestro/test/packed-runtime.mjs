import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import workerThreads from 'node:worker_threads';
import { syncBuiltinESMExports } from 'node:module';
import { Session } from 'node:inspector/promises';
import { PNG } from 'pngjs';
import { resolveProviderPlugins, startProviderRegistry } from '../../plugins/src/registry.ts';
import { emitDiagnostic, withDiagnosticsScope } from '../../host-kit/src/diagnostics.ts';

const [plugin, scratch, mode, core] = process.argv.slice(2);
const workers = [];
const loadedPluginModules = [];
const imports = new Session();
imports.connect();
await imports.post('Debugger.enable');
imports.on('Debugger.scriptParsed', ({ params }) => {
  if (params.url.startsWith(pathToFileURL(fs.realpathSync(plugin)).href))
    loadedPluginModules.push(path.basename(params.url));
});
const OriginalWorker = workerThreads.Worker;
workerThreads.Worker = class extends OriginalWorker {
  constructor(url, options) {
    super(url, options);
    if (String(url).includes('png-worker') && String(url).startsWith(fs.realpathSync(plugin))) {
      const record = { url: String(url), exited: false, terminations: 0 };
      workers.push(record);
      this.on('exit', () => {
        record.exited = true;
      });
      const terminate = this.terminate.bind(this);
      this.terminate = () => {
        record.terminations += 1;
        return terminate();
      };
    }
  }
};
syncBuiltinESMExports();
const { default: maestroPlugin } = await import(
  pathToFileURL(path.join(plugin, 'dist/agent-device.mjs'))
);
async function registry() {
  const registry = await startProviderRegistry(
    await resolveProviderPlugins([{ source: 'embedder', load: () => maestroPlugin() }]),
    {},
    {
      adaptWebDriver: async () => {
        throw new Error('not a provider');
      },
    },
    'replay-backends',
  );
  return {
    close: registry.close,
    select: (host) => registry.resolveReplayBackend('maestro', host),
  };
}
async function embedded(label) {
  const { startAgentDevice } = await import(pathToFileURL(path.join(core, 'dist/src/index.js')));
  let backend;
  const plugin = maestroPlugin();
  const runtime = await startAgentDevice({
    stateDir: path.join(scratch, `embedded-${label}`),
    host: {
      env: {
        AGENT_DEVICE_HOME: path.join(scratch, 'empty-embedded-home'),
        AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS: '0',
      },
      cwd: scratch,
    },
    plugins: [
      {
        ...plugin,
        setup: async (host) => {
          const setup = await plugin.setup(host);
          return {
            ...setup,
            replayBackend: {
              create: async (host) => {
                backend = await setup.replayBackend.create(host);
                return backend;
              },
            },
          };
        },
      },
    ],
  });
  return {
    close: runtime.close,
    select: async () => {
      const entry = path.join(scratch, `embedded-${label}.yaml`);
      fs.writeFileSync(
        entry,
        'appId: com.example.app\n---\n- evalScript: ${output.value = "ok"}\n',
      );
      const response = await runtime.client.replay.run({
        path: entry,
        backend: 'maestro',
        platform: 'ios',
      });
      assert.equal(response.replayed, 1);
      return backend;
    },
  };
}
const first = mode === 'embedded-worker' ? await embedded('first') : await registry();
const second = mode === 'embedded-worker' ? await embedded('second') : await registry();
assert.equal(workers.length, 0, 'unused plugin setup must not load/spawn the worker');
assert.deepEqual(
  loadedPluginModules,
  ['agent-device.mjs'],
  'unused setup evaluates only the engine-free managed entry',
);
imports.disconnect();
const traceLogPath = path.join(scratch, `host-${mode}.ndjson`);
const host = {
  emitDiagnostic,
  registerSensitiveValue() {},
  appendTraceEvent() {},
  buildBuiltinVars: () => ({}),
  readScriptSourceFile: (bundle, file) => bundle.files[file],
  scriptSourceRequiredMessage: 'source required',
  requestSignal: () => undefined,
  resolveTargetDevice: () => {
    throw new Error('explicit platform needs no device discovery');
  },
  buildActionFailureResponse: (failure) => {
    throw new Error(JSON.stringify(failure.error));
  },
};
const backend = await first.select(host);
const other = await second.select(host);
const entry = path.join(scratch, 'packed-runtime.yaml');
const png = PNG.sync.write(new PNG({ width: 2, height: 2 }));
const calls = [];
async function run(selected) {
  const source =
    'appId: com.example.app\n---\n- tapOn:\n    point: "10,20"\n- waitForAnimationToEnd:\n    timeout: 0\n';
  const result = await withDiagnosticsScope({ debug: true, traceLogPath }, () =>
    selected.runReplay({
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
        name: 'packed',
        logPath: path.join(scratch, 'log'),
        store: {
          get: () => undefined,
          lookup: () => undefined,
          resolveOpenRuntimeHints: () => undefined,
        },
      },
      invoke: async (request) => {
        calls.push(request.command);
        if (request.command === 'runtime')
          return { ok: true, data: { viewport: { x: 0, y: 0, width: 400, height: 800 } } };
        if (request.command === 'screenshot') fs.writeFileSync(request.positionals[0], png);
        return { ok: true, data: {} };
      },
    }),
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.data.replayed, 2);
}
try {
  await run(backend);
  assert.equal(workers.length, 1, 'comparison must use the actual packed PNG worker');
  assert.ok(workers[0].url.startsWith(fs.realpathSync(plugin)), workers[0].url);
  assert.equal(workers[0].exited, false);
  if (mode === 'diagnostics') {
    const events = fs
      .readFileSync(traceLogPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const tap = events.find((event) => event.phase === 'maestro_tap_dispatch');
    assert.equal(tap?.level, 'debug');
    assert.deepEqual(tap?.data, { kind: 'point', point: { x: 10, y: 20 } });
    const comparison = events.find((event) => event.phase === 'maestro_screenshot_compare');
    assert.equal(comparison?.data.purpose, 'animation');
    assert.equal(comparison?.data.result, 'stable');
    assert.equal(comparison?.data.differencePercent, 0);
    assert.equal(calls.filter((command) => command === 'screenshot').length, 2);
    assert.equal(calls.filter((command) => command === 'click').length, 1);
  } else {
    await first.close();
    await first.close();
    assert.equal(workers[0].exited, false, 'another registry still owns this worker');
    assert.equal(workers[0].terminations, 0);
    await run(other);
    assert.equal(workers.length, 1, 'remaining owner reuses the live worker');
    await second.close();
    await second.close();
    assert.equal(workers[0].exited, true, 'last owner waits for real worker exit');
    assert.equal(workers[0].terminations, 1, 'last owner terminates once');
  }
  console.log(
    JSON.stringify({
      mode,
      hostLog: fs.existsSync(traceLogPath) ? fs.readFileSync(traceLogPath, 'utf8') : '',
      workers,
      calls,
    }),
  );
} finally {
  await first.close();
  await second.close();
}
