#!/usr/bin/env node
// Run the read-only ASWebAuthenticationSession flow against the loopback fixture provider (#2449).
// Pass extra agent-device arguments after `--`.
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const flow = path.join(repoRoot, 'examples', 'test-app', 'maestro-ios', 'auth-session-sheet.yaml');
const idpScript = path.join(repoRoot, 'examples', 'test-app', 'scripts', 'serve-auth-idp.mjs');
const suiteScript = path.join(repoRoot, 'scripts', 'run-test-app-maestro-suite.mjs');
const passthroughIndex = process.argv.indexOf('--');
const passthrough = passthroughIndex === -1 ? [] : process.argv.slice(passthroughIndex + 1);
const cleanupTimeoutMs = 5_000;

function watchChild(child, name) {
  return new Promise((resolve, reject) => {
    child.on('error', (error) => reject(new Error(`${name}: ${error.message}`)));
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

async function waitForProvider(idp, exit) {
  const lines = createInterface({ input: idp.stdout });
  let timeout;
  try {
    await Promise.race([
      new Promise((resolve, reject) => {
        lines.on('line', (line) => {
          if (line.startsWith('[auth-idp] http')) resolve();
        });
        lines.once('close', () => reject(new Error('provider stdout closed before readiness')));
        lines.once('error', reject);
        timeout = setTimeout(() => reject(new Error('provider was not ready within 15s')), 15_000);
      }),
      exit.then(({ code, signal }) => {
        throw new Error(`provider exited before readiness (${signal ?? code})`);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
    lines.close();
    idp.stdout.resume();
  }
}

function signalSuite(child, signal) {
  if (!child.pid) return false;
  if (process.platform === 'win32') {
    return child.exitCode === null && child.signalCode === null && child.kill(signal);
  }
  try {
    process.kill(-child.pid, signal);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

async function stopSuite(child, exit, signal) {
  if (!signalSuite(child, signal)) return;
  const deadline = Date.now() + cleanupTimeoutMs;
  // The suite runner can exit before its agent-device child on cancellation.
  while (signalSuite(child, 0)) {
    if (Date.now() >= deadline) {
      signalSuite(child, 'SIGKILL');
      break;
    }
    await delay(25);
  }
  await exit.catch(() => {});
}

async function stopProvider(child, exit, signal) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  child.kill(signal);
  const timeout = setTimeout(() => child.kill('SIGKILL'), cleanupTimeoutMs);
  try {
    await exit.catch(() => {});
  } finally {
    clearTimeout(timeout);
  }
}

async function runLane() {
  let suite;
  let suiteExit;
  let signal;
  const { promise: cancellation, resolve: finishCancellation } = Promise.withResolvers();
  function cancel(received) {
    signal ??= received;
    finishCancellation();
  }
  process.on('SIGINT', cancel);
  process.on('SIGTERM', cancel);
  const idp = spawn(process.execPath, ['--experimental-strip-types', idpScript], {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const idpExit = watchChild(idp, 'fixture identity provider');
  try {
    await Promise.race([waitForProvider(idp, idpExit), cancellation]);
    if (signal) return 1;
    // Keep the event loop draining the provider pipe while the suite runs.
    suite = spawn(
      process.execPath,
      [suiteScript, '--platform', 'ios', '--flow', flow, '--', ...passthrough],
      { cwd: repoRoot, stdio: 'inherit', detached: process.platform !== 'win32' },
    );
    suiteExit = watchChild(suite, 'Maestro suite');
    const result = await Promise.race([
      suiteExit,
      cancellation,
      idpExit.then(({ code, signal }) => {
        throw new Error(`provider exited during the suite (${signal ?? code})`);
      }),
    ]);
    return result?.code ?? 1;
  } catch (error) {
    console.error(`[auth-session-lane] ${error.message}`);
    return 1;
  } finally {
    try {
      await Promise.all([
        stopProvider(idp, idpExit, signal ?? 'SIGTERM'),
        suite && stopSuite(suite, suiteExit, signal ?? 'SIGTERM'),
      ]);
    } finally {
      process.off('SIGINT', cancel);
      process.off('SIGTERM', cancel);
    }
  }
}

process.exitCode = await runLane();
