import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { type CliJsonResult, formatResultDebug, runBuiltCliJson } from './cli-json.ts';
import { assertPngFile } from './provider-scenarios/assertions.ts';

const TEST_NAME = 'live web platform e2e smoke';
const WEB_E2E_ENABLED = process.env.AGENT_DEVICE_WEB_E2E === '1';

type StepRecord = {
  step: string;
  command: string;
  status: number;
  timestamp: string;
  errorCode?: string;
  errorMessage?: string;
};

type WebSmokeContext = {
  artifactDir: string;
  common: string[];
  env: NodeJS.ProcessEnv;
  lastSnapshot?: any;
  screenshotPath: string;
  server: Server;
  stepHistory: StepRecord[];
  url: string;
};

test(
  TEST_NAME,
  {
    skip: WEB_E2E_ENABLED
      ? false
      : 'Set AGENT_DEVICE_WEB_E2E=1 to run the managed web backend smoke.',
  },
  async () => {
    await runWebSmoke(await createWebSmokeContext());
  },
);

async function runWebSmoke(context: WebSmokeContext): Promise<void> {
  let opened = false;

  try {
    await runStep(context, 'set up managed web backend', ['web', 'setup', '--json']);
    await runStep(context, 'verify managed web backend', ['web', 'doctor', '--json']);
    await runStep(context, 'open local fixture', ['open', context.url, ...context.common]);
    opened = true;
    await assertInitialWebSurface(context);
    await assertWebNetwork(context);
    await assertReadAndVisibility(context);
    await assertWebInteractions(context);
    await assertWebScreenshot(context);
  } finally {
    await cleanupWebSmoke(context, opened);
  }
}

async function createWebSmokeContext(): Promise<WebSmokeContext> {
  const artifactDir = createArtifactDir();
  const stateDir = path.join(artifactDir, 'agent-device-state');
  const agentBrowserConfigPath = path.join(artifactDir, 'agent-browser.json');
  const session = `ws-${process.pid.toString(36)}-${(Date.now() % 1_679_616).toString(36)}`;
  const fixture = await startFixtureServer();
  const env = {
    ...process.env,
    AGENT_DEVICE_STATE_DIR: stateDir,
    AGENT_BROWSER_CONFIG: agentBrowserConfigPath,
    AGENT_BROWSER_HEADED: 'false',
    AGENT_BROWSER_IDLE_TIMEOUT_MS: '30000',
  };

  mkdirSync(stateDir, { recursive: true });
  writeFileSync(agentBrowserConfigPath, JSON.stringify({ headed: false }, null, 2));

  return {
    artifactDir,
    common: ['--platform', 'web', '--session', session, '--json'],
    env,
    screenshotPath: path.join(artifactDir, 'web-smoke.png'),
    server: fixture.server,
    stepHistory: [],
    url: fixture.url,
  };
}

async function assertInitialWebSurface(context: WebSmokeContext): Promise<void> {
  const snapshot = await runStep(context, 'capture interactive snapshot', [
    'snapshot',
    '-i',
    ...context.common,
  ]);
  const labels = readSnapshotLabels(snapshot.json);
  assert.ok(labels.includes('Ready marker'), `snapshot labels: ${labels.join(', ')}`);
  assert.ok(labels.includes('Email'), `snapshot labels: ${labels.join(', ')}`);
  assert.ok(labels.includes('Submit order'), `snapshot labels: ${labels.join(', ')}`);
}

async function assertReadAndVisibility(context: WebSmokeContext): Promise<void> {
  await assertCommandData(
    context,
    'wait for ready text',
    ['wait', 'text', 'Ready marker', '5000'],
    {
      text: 'Ready marker',
    },
  );
  await assertCommandData(
    context,
    'read ready text through selector',
    ['get', 'text', 'label="Ready marker"'],
    { text: 'Ready marker' },
  );
  await assertCommandData(
    context,
    'assert submit visible',
    ['is', 'visible', 'label="Submit order"'],
    { pass: true },
  );
}

async function assertWebNetwork(context: WebSmokeContext): Promise<void> {
  const result = await runStep(context, 'inspect browser network', [
    'network',
    'dump',
    '10',
    '--include',
    'headers',
    ...context.common,
  ]);
  assert.equal(result.json?.data?.backend, 'agent-browser');
  const entries: unknown[] = Array.isArray(result.json?.data?.entries)
    ? result.json.data.entries
    : [];
  const fixtureEntry = entries.find(
    (entry): entry is Record<string, unknown> =>
      typeof entry === 'object' && entry !== null && 'url' in entry && entry.url === context.url,
  );
  if (!fixtureEntry) {
    failWithContext(context, 'inspect browser network', ['network', 'dump', '10'], result);
  }
  assert.equal(fixtureEntry.method, 'GET');
  assert.equal(typeof fixtureEntry.requestHeaders, 'object');
}

async function assertWebInteractions(context: WebSmokeContext): Promise<void> {
  await runStep(context, 'click submit', ['click', 'label="Submit order"', ...context.common]);
  await runStep(context, 'wait for click result', [
    'wait',
    'text',
    'Submitted',
    '5000',
    ...context.common,
  ]);
  await runStep(context, 'fill email field', [
    'fill',
    'label="Email"',
    'qa@example.test',
    ...context.common,
  ]);
  await runStep(context, 'wait for fill result', [
    'wait',
    'text',
    'Email qa@example.test',
    '5000',
    ...context.common,
  ]);
}

async function assertWebScreenshot(context: WebSmokeContext): Promise<void> {
  await assertCommandData(
    context,
    'capture screenshot artifact',
    ['screenshot', context.screenshotPath, '--fullscreen', '--no-stabilize'],
    { path: context.screenshotPath },
  );
  assertPngFile(context.screenshotPath);
}

async function assertCommandData(
  context: WebSmokeContext,
  step: string,
  args: string[],
  expected: Record<string, unknown>,
): Promise<void> {
  const fullArgs = [...args, ...context.common];
  const result = await runStep(context, step, fullArgs);
  for (const [key, value] of Object.entries(expected)) {
    if (result.json?.data?.[key] === value) continue;
    failWithContext(context, step, fullArgs, result, `${key} !== ${JSON.stringify(value)}`);
  }
}

async function runStep(
  context: WebSmokeContext,
  step: string,
  args: string[],
  expectedStatus = 0,
): Promise<CliJsonResult> {
  const result = await runBuiltCliJson(args, context.env);
  recordStep(context, step, args, result);
  maybeCaptureSnapshot(context, args, result);
  if (result.status !== expectedStatus) failWithContext(context, step, args, result);
  return result;
}

async function cleanupWebSmoke(context: WebSmokeContext, opened: boolean): Promise<void> {
  const errors: unknown[] = [];
  if (opened) {
    try {
      await runStep(context, 'close web session', ['close', ...context.common], 0);
    } catch (error) {
      errors.push(error);
    }
  }
  try {
    await closeServer(context.server);
  } catch (error) {
    errors.push(error);
  }
  if (errors.length === 1) {
    throw errors[0];
  }
  if (errors.length > 1) {
    throw new AggregateError(errors, 'web smoke cleanup failed');
  }
}

function recordStep(
  context: WebSmokeContext,
  step: string,
  args: string[],
  result: CliJsonResult,
): void {
  const errorCode =
    typeof result.json?.error?.code === 'string' ? result.json.error.code : undefined;
  const errorMessage =
    typeof result.json?.error?.message === 'string' ? result.json.error.message : undefined;
  context.stepHistory.push({
    step,
    command: `agent-device ${args.join(' ')}`,
    status: result.status,
    timestamp: new Date().toISOString(),
    errorCode,
    errorMessage,
  });
}

function maybeCaptureSnapshot(
  context: WebSmokeContext,
  args: string[],
  result: CliJsonResult,
): void {
  if (args[0] !== 'snapshot' || result.status !== 0) return;
  if (!Array.isArray(result.json?.data?.nodes)) return;
  context.lastSnapshot = result.json;
}

function failWithContext(
  context: WebSmokeContext,
  step: string,
  args: string[],
  result: CliJsonResult,
  assertionDetail?: string,
): never {
  const message = buildFailureDebug(context, step, args, result, assertionDetail);
  writeFailureArtifacts(context, step, args, result, message, assertionDetail);
  assert.fail(message);
}

function buildFailureDebug(
  context: WebSmokeContext,
  step: string,
  args: string[],
  result: CliJsonResult,
  assertionDetail?: string,
): string {
  const lines = [formatResultDebug(step, args, result)];
  if (assertionDetail) lines.push('assertion:', assertionDetail);
  lines.push('last snapshot context:', formatLastSnapshotContext(context));
  lines.push('recent step history:', formatStepHistory(context));
  lines.push('artifacts:', context.artifactDir);
  return lines.join('\n');
}

function writeFailureArtifacts(
  context: WebSmokeContext,
  step: string,
  args: string[],
  result: CliJsonResult,
  message: string,
  assertionDetail?: string,
): void {
  writeFileSync(path.join(context.artifactDir, 'failed-step.txt'), message);
  writeFileSync(
    path.join(context.artifactDir, 'failed-step.json'),
    JSON.stringify(
      { step, command: `agent-device ${args.join(' ')}`, assertionDetail, result },
      null,
      2,
    ),
  );
  writeFileSync(
    path.join(context.artifactDir, 'step-history.json'),
    JSON.stringify(context.stepHistory, null, 2),
  );
  if (context.lastSnapshot) {
    writeFileSync(
      path.join(context.artifactDir, 'last-snapshot.json'),
      JSON.stringify(context.lastSnapshot, null, 2),
    );
  }
}

function formatLastSnapshotContext(context: WebSmokeContext): string {
  const nodes = context.lastSnapshot?.data?.nodes;
  if (!Array.isArray(nodes)) return '(none)';
  const preview = nodes
    .slice(0, 12)
    .map((node: { ref?: unknown; type?: unknown; label?: unknown; rect?: unknown }, i: number) => {
      const rect = node.rect ? JSON.stringify(node.rect) : '(no-bounds)';
      return `${i + 1}. ${String(node.ref ?? '(no-ref)')} type=${String(node.type ?? '(no-type)')} label=${JSON.stringify(node.label ?? '')} rect=${rect}`;
    });
  return [`nodes: ${nodes.length}`, 'nodePreview:', preview.join('\n')].join('\n');
}

function formatStepHistory(context: WebSmokeContext): string {
  return context.stepHistory
    .slice(-8)
    .map((stepRecord) => {
      const error =
        stepRecord.errorCode || stepRecord.errorMessage
          ? ` error=${stepRecord.errorCode ?? ''}${stepRecord.errorMessage ? `:${stepRecord.errorMessage}` : ''}`
          : '';
      return `${stepRecord.timestamp} status=${stepRecord.status}${error} ${stepRecord.step} :: ${stepRecord.command}`;
    })
    .join('\n');
}

async function startFixtureServer(): Promise<{ server: Server; url: string }> {
  const server = createServer((request, response) => {
    if (request.url !== '/') {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('not found');
      return;
    }

    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(fixtureHtml());
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  assert.ok(address && typeof address === 'object', 'fixture server did not bind to a port');
  return { server, url: `http://127.0.0.1:${address.port}/` };
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function readSnapshotLabels(json: any): string[] {
  const nodes = Array.isArray(json?.data?.nodes) ? json.data.nodes : [];
  return nodes.flatMap((node: { label?: unknown }) =>
    typeof node.label === 'string' && node.label.length > 0 ? [node.label] : [],
  );
}

function createArtifactDir(): string {
  const runId = new Date().toISOString().replaceAll(':', '-');
  const artifactDir = path.resolve('test/artifacts/web/live-web-platform-e2e-smoke', runId);
  mkdirSync(artifactDir, { recursive: true });
  return artifactDir;
}

function fixtureHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Agent Device Web Smoke</title>
    <style>
      body {
        font-family: system-ui, sans-serif;
        margin: 32px;
      }
      main {
        max-width: 420px;
      }
      label,
      button,
      input {
        display: block;
        font: inherit;
        margin-block: 12px;
      }
      input,
      button {
        min-height: 40px;
        min-width: 220px;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Agent Device Web Smoke</h1>
      <button id="ready" type="button">Ready marker</button>
      <label for="email">Email</label>
      <input id="email" name="email" aria-label="Email" autocomplete="off" />
      <button id="submit" type="button">Submit order</button>
      <p id="status" role="status" aria-live="polite">Idle</p>
    </main>
    <script>
      const email = document.querySelector('#email');
      const status = document.querySelector('#status');
      const submit = document.querySelector('#submit');
      submit.addEventListener('click', () => {
        submit.textContent = 'Submitted';
        status.textContent = 'Clicked submit';
      });
      email.addEventListener('input', () => {
        email.setAttribute('aria-label', 'Email ' + email.value);
        status.textContent = 'Email: ' + email.value;
      });
    </script>
  </body>
</html>`;
}
