import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { type CliJsonResult, formatResultDebug, runBuiltCliJson } from './cli-json.ts';
import { assertPngDimensions, assertPngFile } from './provider-scenarios/assertions.ts';
import { runCleanupWithCoverageReport } from './web-e2e/coverage-report.ts';
import { assertNoDaemonLeaks } from './support/daemon-leak-oracle.ts';
import {
  inspectManagedAgentBrowserProcesses,
  summarizeAgentBrowserProcesses,
  type AgentBrowserProcessSummary,
} from '../../src/platforms/web/agent-browser-lifecycle.ts';
import {
  getManagedAgentBrowserStatus,
  type AgentBrowserToolStatus,
} from '../../src/platforms/web/agent-browser-tool.ts';
import { stopProcessForTakeover } from '../../src/daemon/daemon-process.ts';
import {
  expandProcessTree,
  isProcessAlive,
  listHostProcesses,
  readProcessStartTime,
  stopPidsWithEscalation,
} from '../../src/utils/host-process.ts';

const TEST_NAME = 'live web platform e2e smoke';
const SHUTDOWN_TEST_NAME = 'live web platform e2e daemon-shutdown browser cleanup';
const WEB_E2E_ENABLED = process.env.AGENT_DEVICE_WEB_E2E === '1';
const WEB_SHUTDOWN_SETTLE_TIMEOUT_MS = 45_000;
const WEB_SHUTDOWN_SETTLE_POLL_MS = 500;
const WEB_SHUTDOWN_CLEANUP_TIMEOUT_MS = 5_000;
// #1868: SIGTERM must close the managed Chrome fleet well before agent-browser's own idle timer
// would have. The shutdown lane owns this value directly, at a fixed offset above its own poll
// deadline, rather than the functional smoke test's shortened override or an omitted-env-var
// assumption about agent-browser's default — so a future change to either stays unable to make
// this pass for the wrong reason. A pass can then only mean the daemon's shutdown teardown
// actively closed the browser, not that agent-browser's own idle timer beat this test's own wait.
const WEB_SHUTDOWN_IDLE_TIMEOUT_MS = WEB_SHUTDOWN_SETTLE_TIMEOUT_MS + 60_000;

type WebShutdownDaemonIdentity = {
  pid: number;
  startTime: string;
};

test('web shutdown cleanup reaps the exact daemon that survived graceful shutdown', async (t) => {
  const root = mkdtempSync('/tmp/agent-device-web-shutdown-cleanup-');
  const entryPath = path.join(root, 'src', 'daemon.ts');
  mkdirSync(path.dirname(entryPath), { recursive: true });
  writeFileSync(
    entryPath,
    [
      "process.on('SIGTERM', () => process.send?.('sigterm-ignored'));",
      "process.send?.('ready');",
      'setInterval(() => {}, 1000);',
      '',
    ].join('\n'),
    'utf8',
  );
  const child = spawn(process.execPath, [entryPath], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  const daemonPid = child.pid ?? 0;
  assert.ok(daemonPid > 0, 'expected the fake daemon to have a pid');
  t.after(() => {
    if (isProcessAlive(daemonPid)) process.kill(daemonPid, 'SIGKILL');
    rmSync(root, { recursive: true, force: true });
  });

  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('message', (message) => {
      child.off('error', reject);
      assert.equal(message, 'ready');
      resolve();
    });
  });
  let ignoredSigterm = false;
  child.on('message', (message) => {
    if (message === 'sigterm-ignored') ignoredSigterm = true;
  });

  const daemonStartTime = readProcessStartTime(daemonPid);
  assert.ok(daemonStartTime, 'expected the fake daemon to report a start time');
  await cleanupWebShutdownSmoke(
    {
      artifactDir: root,
      common: [],
      env: {},
      screenshotPath: path.join(root, 'unused.png'),
      server: createServer(),
      stepHistory: [],
      url: 'http://127.0.0.1',
    },
    { pid: daemonPid, startTime: daemonStartTime },
    undefined,
    { termTimeoutMs: 50, killTimeoutMs: 1_000 },
  );

  assert.equal(
    ignoredSigterm,
    true,
    'expected cleanup to escalate after the child ignored SIGTERM',
  );
  assert.equal(isProcessAlive(daemonPid), false);
});

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
    // Shortens agent-browser's own idle-reap window so a leaked fleet from this test doesn't
    // linger on the runner; the shutdown lane below deliberately omits this override instead.
    await runWebSmoke(await createWebSmokeContext({ agentBrowserIdleTimeoutMs: '30000' }));
  },
);

// #1868: teardownSessionResources gained a best-effort web-close step so a daemon shutdown (or
// an expired-session reap) tells agent-browser to close its Chrome fleet immediately instead of
// leaving it for agent-browser's own multi-minute idle timer. The unit tests around
// teardownSessionResources and teardownDaemonSessionForShutdown mock the agent-browser CLI call
// and prove only that it gets dispatched with the right arguments; this live lane is the one
// place that proves the whole chain — a real managed browser, a real daemon process, a real
// SIGTERM — actually ends with zero owned Chrome processes, not just an issued close command.
test(
  SHUTDOWN_TEST_NAME,
  {
    skip: WEB_E2E_ENABLED
      ? false
      : 'Set AGENT_DEVICE_WEB_E2E=1 to run the managed web backend smoke.',
  },
  async () => {
    await runWebShutdownSmoke(
      await createWebSmokeContext({
        agentBrowserIdleTimeoutMs: String(WEB_SHUTDOWN_IDLE_TIMEOUT_MS),
      }),
    );
  },
);

async function runWebShutdownSmoke(context: WebSmokeContext): Promise<void> {
  // Cleanup authority lives entirely in `finally`, driven by these two, so a failed assertion
  // above (including the very failure this test exists to catch: processes still alive when the
  // fix regresses) can never leave a daemon or a Chrome fleet running on the host afterward.
  let daemonIdentity: WebShutdownDaemonIdentity | undefined;
  let status: AgentBrowserToolStatus | undefined;
  try {
    await runStep(context, 'set up managed web backend', ['web', 'setup', '--json']);
    await runStep(context, 'open local fixture', ['open', context.url, ...context.common]);

    const stateDir = context.env.AGENT_DEVICE_STATE_DIR;
    assert.ok(stateDir, 'expected the smoke context to configure a state dir');
    status = getManagedAgentBrowserStatus({ stateDir });

    const before = await inspectManagedAgentBrowserProcesses(status);
    assert.ok(
      before.count > 0,
      `expected the managed browser fleet to be running after open, found none: ${formatProcessSummary(before)}`,
    );

    const daemonPid = readDaemonPid(stateDir);
    const daemonStartTime = readProcessStartTime(daemonPid);
    assert.ok(daemonStartTime, 'expected the daemon process to report a start time');
    daemonIdentity = { pid: daemonPid, startTime: daemonStartTime };
    assert.equal(isProcessAlive(daemonPid), true, 'expected a live daemon before SIGTERM');

    // The scenario #1868 is about: SIGTERM the daemon directly, the way an operator or an
    // orchestrator shutting the container down would, rather than going through `close`.
    process.kill(daemonPid, 'SIGTERM');

    const after = await settleManagedBrowserProcesses(status);
    assert.equal(
      after.count,
      0,
      `expected zero owned Chrome processes after daemon shutdown, found: ${formatProcessSummary(after)}`,
    );
    assert.equal(
      isProcessAlive(daemonPid),
      false,
      'expected the daemon process itself to have exited after SIGTERM',
    );

    // #1781 B1: the daemon leak oracle this fix unblocks wiring to a web lane — no stray
    // state-dir residue either, on top of the process-level proof above.
    await assertNoDaemonLeaks({ stateDir, daemonPids: [daemonPid], phase: 'after-shutdown' });
  } finally {
    await cleanupWebShutdownSmoke(context, daemonIdentity, status);
  }
}

// Best-effort and independent of how far the `try` block got: a daemon that survived SIGTERM
// (stopProcessForTakeover escalates to SIGKILL) and a Chrome fleet that outlived it (a forceful
// reap, not cleanupManagedAgentBrowserOrphans — see forceKillManagedBrowserProcesses) are reaped
// here regardless of which assertion above failed, or whether none did. Mirrors cleanupWebSmoke's
// AggregateError shape so a cleanup failure never silently swallows the assertion failure it ran
// alongside.
async function cleanupWebShutdownSmoke(
  context: WebSmokeContext,
  daemonIdentity: WebShutdownDaemonIdentity | undefined,
  status: AgentBrowserToolStatus | undefined,
  timeouts = {
    termTimeoutMs: WEB_SHUTDOWN_CLEANUP_TIMEOUT_MS,
    killTimeoutMs: WEB_SHUTDOWN_CLEANUP_TIMEOUT_MS,
  },
): Promise<void> {
  const errors: unknown[] = [];
  if (daemonIdentity !== undefined) {
    try {
      await stopProcessForTakeover(daemonIdentity.pid, {
        termTimeoutMs: timeouts.termTimeoutMs,
        killTimeoutMs: timeouts.killTimeoutMs,
        expectedStartTime: daemonIdentity.startTime,
      });
    } catch (error) {
      errors.push(error);
    }
  }
  if (status) {
    try {
      await forceKillManagedBrowserProcesses(status);
    } catch (error) {
      errors.push(error);
    }
  }
  try {
    await closeServer(context.server);
  } catch (error) {
    errors.push(error);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, 'web shutdown smoke cleanup failed');
}

// Deliberately NOT cleanupManagedAgentBrowserOrphans: that function exists to leave an actively
// used fleet alone, and skips killing anything once it sees activity inside the (here, minutes-
// long) idle window — precisely the state this test's own fleet is always in. A forced safety-net
// cleanup needs the opposite property: reap whatever this test's own fleet still owns, regardless
// of how recently it was used, so a planted regression (no active close on shutdown) cannot leave
// Chrome processes running on the host just because cleanup honored the same idle guard the
// regression exploits.
async function forceKillManagedBrowserProcesses(status: AgentBrowserToolStatus): Promise<void> {
  const processes = await listHostProcesses({ timeoutMs: WEB_SHUTDOWN_CLEANUP_TIMEOUT_MS });
  const summary = summarizeAgentBrowserProcesses(processes, status);
  if (summary.count === 0) return;
  const signalPids = expandProcessTree(summary.pids, processes).map(
    (processInfo) => processInfo.pid,
  );
  await stopPidsWithEscalation({
    pids: signalPids,
    termTimeoutMs: WEB_SHUTDOWN_CLEANUP_TIMEOUT_MS,
    killTimeoutMs: WEB_SHUTDOWN_CLEANUP_TIMEOUT_MS,
  });
}

function readDaemonPid(stateDir: string): number {
  const info = JSON.parse(readFileSync(path.join(stateDir, 'daemon.json'), 'utf8')) as {
    pid?: number;
  };
  assert.equal(typeof info.pid, 'number', `daemon.json has no pid: ${JSON.stringify(info)}`);
  return info.pid as number;
}

async function settleManagedBrowserProcesses(
  status: AgentBrowserToolStatus,
): Promise<AgentBrowserProcessSummary> {
  const deadline = Date.now() + WEB_SHUTDOWN_SETTLE_TIMEOUT_MS;
  let summary = await inspectManagedAgentBrowserProcesses(status);
  while (summary.count > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, WEB_SHUTDOWN_SETTLE_POLL_MS));
    summary = await inspectManagedAgentBrowserProcesses(status);
  }
  return summary;
}

function formatProcessSummary(summary: AgentBrowserProcessSummary): string {
  return JSON.stringify({
    count: summary.count,
    pids: summary.pids,
    reasons: summary.processes.map((match) => match.reason),
  });
}

async function runWebSmoke(context: WebSmokeContext): Promise<void> {
  let opened = false;

  try {
    await runStep(context, 'set up managed web backend', ['web', 'setup', '--json']);
    await runStep(context, 'verify managed web backend', ['web', 'doctor', '--json']);
    await runStep(context, 'open local fixture', ['open', context.url, ...context.common]);
    opened = true;
    await assertWebViewport(context);
    await assertInitialWebSurface(context);
    await assertWebNetwork(context);
    await assertReadAndVisibility(context);
    await assertWebInteractions(context);
    await assertWebScreenshot(context);
  } finally {
    await runCleanupWithCoverageReport(context.artifactDir, context.stepHistory, () =>
      cleanupWebSmoke(context, opened),
    );
  }
}

async function assertWebViewport(context: WebSmokeContext): Promise<void> {
  await assertCommandData(context, 'resize browser viewport', ['viewport', '640', '480'], {
    width: 640,
    height: 480,
  });
}

async function createWebSmokeContext(
  options: { agentBrowserIdleTimeoutMs?: string } = {},
): Promise<WebSmokeContext> {
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
    ...(options.agentBrowserIdleTimeoutMs === undefined
      ? {}
      : { AGENT_BROWSER_IDLE_TIMEOUT_MS: options.agentBrowserIdleTimeoutMs }),
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
  await assertCommandData(
    context,
    'find ready text by locator',
    ['find', 'text', 'Ready marker', 'exists'],
    { found: true },
  );
  await assertCommandData(
    context,
    'find ready text by selector expression',
    ['find', 'text="Ready marker"', 'exists'],
    { found: true },
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
    ['screenshot', context.screenshotPath, '--no-stabilize'],
    { path: context.screenshotPath },
  );
  assertPngFile(context.screenshotPath);
  assertPngDimensions(context.screenshotPath, 640, 480);
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
