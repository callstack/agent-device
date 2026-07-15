import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

export const PROJECT_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');

const RUNNER_SOURCES_DIR = path.join(
  PROJECT_ROOT,
  'apple',
  'runner',
  'AgentDeviceRunner',
  'AgentDeviceRunnerUITests',
);

export function assertRunnerSourceIncludes(via: string, context: string): void {
  const [fileName, symbol] = via.split('#');
  assert.ok(fileName && symbol, `${context}: runner via must be "<file>#<symbol>", got "${via}"`);
  const absolute = path.join(RUNNER_SOURCES_DIR, fileName);
  assert.ok(fs.existsSync(absolute), `${context}: runner source not found: ${fileName}`);
  assert.ok(
    fs.readFileSync(absolute, 'utf8').includes(symbol),
    `${context}: "${symbol}" not found in ${fileName}`,
  );
}
