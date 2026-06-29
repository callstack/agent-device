#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binPath = path.join(repoRoot, 'bin', 'agent-device.mjs');

const options = {
  platform: 'ios',
  session: 'test-app-maestro',
  flowDir: path.join(repoRoot, 'examples', 'test-app', 'maestro'),
  close: false,
  passthrough: [],
};

for (let index = 2; index < process.argv.length; index += 1) {
  const arg = process.argv[index];
  if (arg === '--') {
    options.passthrough.push(...process.argv.slice(index + 1));
    break;
  }
  if (arg === '--platform' && process.argv[index + 1]) {
    options.platform = process.argv[index + 1];
    index += 1;
    continue;
  }
  if (arg === '--session' && process.argv[index + 1]) {
    options.session = process.argv[index + 1];
    index += 1;
    continue;
  }
  if (arg === '--flow-dir' && process.argv[index + 1]) {
    options.flowDir = path.resolve(process.argv[index + 1]);
    index += 1;
    continue;
  }
  if (arg === '--close') {
    options.close = true;
    continue;
  }
  options.passthrough.push(arg);
}

const flows = fs
  .readdirSync(options.flowDir)
  .filter((entry) => entry.endsWith('.yaml') || entry.endsWith('.yml'))
  .sort()
  .map((entry) => path.join(options.flowDir, entry));

if (flows.length === 0) {
  console.error(`No Maestro flows found in ${options.flowDir}`);
  process.exit(1);
}

function runAgentDevice(args) {
  execFileSync(process.execPath, [binPath, '--session', options.session, ...args], {
    cwd: repoRoot,
    stdio: 'inherit',
  });
}

runAgentDevice([
  'test',
  ...flows,
  '--maestro',
  '--platform',
  options.platform,
  ...options.passthrough,
]);

if (options.close) {
  runAgentDevice(['close']);
}
