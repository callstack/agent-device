import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const checkout = path.resolve(process.argv[2] ?? '.');
const output = path.resolve(process.argv[3] ?? '.tmp/android-automation-benchmark.json');
await mkdir(path.dirname(output), { recursive: true });
const rounds = Number(process.env.BENCH_ROUNDS ?? 20);
assert(Number.isInteger(rounds) && rounds > 0, 'BENCH_ROUNDS must be a positive integer');
const serial = process.env.ANDROID_SERIAL;
assert(serial, 'Set ANDROID_SERIAL to an exclusively owned emulator');
const { createAgentDeviceClient } = await import(
  pathToFileURL(path.join(checkout, 'dist/src/index.js'))
);
const client = createAgentDeviceClient({
  session: 'android-automation-benchmark',
  stateDir: `${output}.state`,
  platform: 'android',
  serial,
});
const samples = {};
async function measure(name, run) {
  const start = performance.now();
  await run();
  (samples[name] ??= []).push(performance.now() - start);
}
async function email() {
  const snapshot = await client.capture.snapshot({ interactiveOnly: true });
  const node = snapshot.nodes.find(
    (n) => n.identifier === 'field-email' || n.identifier?.endsWith(':id/field-email'),
  );
  assert(node?.ref, 'The current test-app Checkout form must expose field-email');
  return { ref: `@${node.ref}~s${snapshot.refsGeneration}` };
}
let opened = false;
try {
  await measure('open', async () => {
    await client.apps.open({
      app: 'com.callstack.agentdevicelab',
      url: 'agent-device-test-app:///form',
      foreground: true,
    });
    opened = true;
  });
  await email();
  for (let i = 0; i < 3; i++) {
    await measure('restart', () =>
      client.apps.open({
        app: 'com.callstack.agentdevicelab',
        url: 'agent-device-test-app:///form',
        relaunch: true,
      }),
    );
  }
  await email();
  for (let i = 0; i < rounds; i++)
    await measure('observe', () => client.capture.snapshot({ interactiveOnly: true }));
  for (let i = 0; i < rounds; i++) {
    const target = await email();
    await measure('tap', () => client.interactions.press(target));
  }
  for (let i = 0; i < rounds; i++) {
    const target = await email();
    const text = `user${String(i).padStart(2, '0')}@example.test`;
    await measure('fill', () => client.interactions.fill({ ...target, text }));
    const result = await client.interactions.get({ format: 'text', selector: 'id="field-email"' });
    assert.equal(result.text, text, 'A fast fill must actually reach the selected field');
  }
  for (let i = 0; i < Math.min(rounds, 10); i++) {
    await measure('screenshot', () => client.capture.screenshot({ path: `${output}.${i}.png` }));
  }
} finally {
  if (opened) await client.apps.close();
}
const percentile = (values, p) =>
  values.toSorted((a, b) => a - b)[Math.ceil(values.length * p) - 1];
const summary = Object.fromEntries(
  Object.entries(samples).map(([name, values]) => [
    name,
    {
      count: values.length,
      p50: percentile(values, 0.5),
      p95: percentile(values, 0.95),
    },
  ]),
);
await mkdir(path.dirname(output), { recursive: true });
const version = JSON.parse(await readFile(path.join(checkout, 'package.json'), 'utf8')).version;
await writeFile(
  output,
  `${JSON.stringify({ observedAt: new Date().toISOString(), checkout, version, serial, rounds, summary, samples }, null, 2)}\n`,
);
console.log(JSON.stringify(summary, null, 2));
