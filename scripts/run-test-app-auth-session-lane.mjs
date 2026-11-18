#!/usr/bin/env node
// Run the read-only ASWebAuthenticationSession flow against the loopback fixture provider (#2449).
// Pass extra agent-device arguments after `--`.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { startAuthIdpServer } from '../examples/test-app/src/auth-idp-server.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const flow = path.join(repoRoot, 'examples', 'test-app', 'maestro-ios', 'auth-session-sheet.yaml');
const suiteScript = path.join(repoRoot, 'scripts', 'run-test-app-maestro-suite.mjs');
const passthroughIndex = process.argv.indexOf('--');
const passthrough = passthroughIndex === -1 ? [] : process.argv.slice(passthroughIndex + 1);
const cleanupTimeoutMs = 5_000;

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

async function runLane() {
  let provider;
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
  try {
    provider = await startAuthIdpServer();
    if (signal) return 1;
    suite = spawn(
      process.execPath,
      [suiteScript, '--platform', 'ios', '--flow', flow, '--', ...passthrough],
      { cwd: repoRoot, stdio: 'inherit', detached: process.platform !== 'win32' },
    );
    suiteExit = once(suite, 'exit');
    const result = await Promise.race([suiteExit, cancellation]);
    return result?.[0] ?? 1;
  } catch (error) {
    console.error(`[auth-session-lane] ${error.message}`);
    return 1;
  } finally {
    try {
      await Promise.all([
        provider?.close(),
        suite && stopSuite(suite, suiteExit, signal ?? 'SIGTERM'),
      ]);
    } finally {
      process.off('SIGINT', cancel);
      process.off('SIGTERM', cancel);
    }
  }
}

process.exitCode = await runLane();
