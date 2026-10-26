/**
 * The shipped host app reaches the unit-test fixture screens through a string, not a symbol:
 * `+agentDeviceRootViewControllerClass` looks up `AgentDeviceRunnerFixtureViewController` with
 * NSClassFromString and falls back to the plain host when the class is absent. A rename on the
 * fixtures side would then fail silently — production keeps working, every fixture-dependent test
 * starts falling back to the plain host. This guard makes that rename fail CI instead.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const hostSource = path.join(
  repoRoot,
  'apple/runner/AgentDeviceRunner/AgentDeviceRunner/AgentDeviceRunnerApp.m',
);
const fixturesSource = path.join(
  repoRoot,
  'apple/runner/AgentDeviceRunner/AgentDeviceRunner/AgentDeviceRunnerAppFixtures.m',
);

test('the host app looks up a fixture class the fixtures file declares', () => {
  const host = fs.readFileSync(hostSource, 'utf8');
  // The host app resolves exactly one class by name: the fixture host in
  // +agentDeviceRootViewControllerClass. Asserting the single occurrence keeps this guard from
  // silently validating a different lookup if another NSClassFromString is ever added.
  const lookups = [...host.matchAll(/NSClassFromString\(@"(\w+)"\)/g)];
  assert.equal(lookups.length, 1, 'the host app must hold exactly one NSClassFromString lookup');
  const className = lookups[0]![1]!;
  assert.match(host, /\+ \(Class\)agentDeviceRootViewControllerClass/);
  const fixtures = fs.readFileSync(fixturesSource, 'utf8');
  // The class the host names must be declared and implemented by the fixtures file.
  assert.match(fixtures, new RegExp(`@interface ${className} :`));
  assert.match(fixtures, new RegExp(`@implementation ${className}\\b`));
});
