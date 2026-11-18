#!/usr/bin/env node
// Runs the sign-in sheet lane: the fixture identity provider plus the Maestro flow that drives the
// ASWebAuthenticationSession sheet through it (#2449).
//
//   pnpm test-app:maestro:auth:ios
//
// The identity provider is a separate process because the sheet's page is fetched by the hosted
// SafariViewService surface over the host's loopback interface, not by the app. This script owns
// that process: it starts before the flow, and the flow's exit — pass or fail — stops it.
//
// The flow needs a fixture app built with the AuthSessionLab module (examples/test-app/README.md).
// Pass extra agent-device arguments after `--`.
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const flowDir = path.join(repoRoot, 'examples', 'test-app', 'maestro-ios');
const idpScript = path.join(repoRoot, 'examples', 'test-app', 'scripts', 'serve-auth-idp.mjs');
const passthroughIndex = process.argv.indexOf('--');
const passthrough = passthroughIndex === -1 ? [] : process.argv.slice(passthroughIndex + 1);

const idp = spawn(process.execPath, ['--experimental-strip-types', idpScript], {
  cwd: repoRoot,
  stdio: ['ignore', 'pipe', 'inherit'],
});
idp.stdout.setEncoding('utf8');

// The IdP prints its listen line before it can serve the sheet. Waiting for that line keeps a slow
// start from being reported as an unserved sheet inside the flow.
await new Promise((resolve, reject) => {
  const fail = (message) => reject(new Error(message));
  const timeout = setTimeout(() => fail('did not print its listen line within 15s'), 15_000);
  const onData = (chunk) => {
    if (!chunk.includes('[auth-idp] http')) return;
    clearTimeout(timeout);
    idp.stdout.removeListener('data', onData);
    resolve();
  };
  idp.stdout.on('data', onData);
  idp.once('error', (error) => {
    clearTimeout(timeout);
    fail(error.message);
  });
  idp.once('exit', (code) => {
    clearTimeout(timeout);
    fail(`exited with code ${String(code)} before it started`);
  });
})
  .then(() => {
    // The flow runs through `spawnSync`, so this loop cannot keep reading the IdP while it runs. The
    // IdP logs one line per request, and a pipe nobody reads fills up and blocks the IdP, which would
    // stall the sheet's own fetch. `resume()` puts the stream in flowing mode and discards the output.
    idp.stdout.resume();
    const suite = spawnSync(
      process.execPath,
      [
        path.join(repoRoot, 'scripts', 'run-test-app-maestro-suite.mjs'),
        '--flow-dir',
        flowDir,
        '--platform',
        'ios',
        ...passthrough,
      ],
      { cwd: repoRoot, stdio: 'inherit' },
    );
    process.exitCode = suite.signal ? 1 : (suite.status ?? 1);
  })
  .catch((error) => {
    console.error(
      `[auth-session-lane] fixture identity provider ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  })
  .finally(() => {
    if (idp.exitCode === null && !idp.killed) idp.kill('SIGTERM');
  });
