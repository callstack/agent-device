/**
 * The failure direction of the packager's host-app guard, end to end: `--check` over a host app
 * target that switches on a `--agent-device-*` fixture launch argument must fail, and the same
 * tree without it must pass. The repo's own tree can only ever show the healthy side — on main the
 * fixture screens sat inside AgentDeviceRunnerApp.m and the packager copied them silently — so the
 * violating file is built here from that shape.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'vitest';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const packager = path.join(repoRoot, 'scripts', 'package-apple-runner-source.mjs');
const HOST_APP_DIR = path.join(
  'apple',
  'runner',
  'AgentDeviceRunner',
  'AgentDeviceRunner',
  'AgentDeviceRunner',
);

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

/** A runner tree holding only what the packager's host-app rule reads. */
function fixtureRunnerRoot(hostAppSource: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-packager-fixture-'));
  tempRoots.push(root);
  const appDir = path.join(root, HOST_APP_DIR);
  fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(path.join(appDir, 'AgentDeviceRunnerApp.h'), '@interface V : NSObject\n@end\n');
  fs.writeFileSync(path.join(appDir, 'AgentDeviceRunnerApp.m'), hostAppSource);
  fs.mkdirSync(path.join(root, 'apple', 'snapshot-presentation'), { recursive: true });
  fs.writeFileSync(path.join(root, 'apple', 'snapshot-presentation', 'Package.runner.swift'), '\n');
  return root;
}

function runPackagerCheck(root: string): { ok: boolean; output: string } {
  try {
    const stdout = execFileSync(
      process.execPath,
      [packager, '--root', root, '--check', '--quiet'],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    return { ok: true, output: stdout };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string };
    return { ok: false, output: `${failure.stdout ?? ''}${failure.stderr ?? ''}` };
  }
}

/** The shape main shipped: the fixture screen compiled into the host app the package copies. */
const HOST_APP_WITH_FIXTURE_SCREEN =
  '@implementation AgentDeviceRunnerViewController\n' +
  '- (void)viewDidLoad {\n' +
  '  if ([NSProcessInfo.processInfo.arguments containsObject:@"--agent-device-back-regression"]) {\n' +
  '  }\n' +
  '}\n' +
  '@end\n';

const HOST_APP_WITHOUT_FIXTURE_SCREEN =
  '@implementation AgentDeviceRunnerViewController\n' +
  '- (void)viewDidLoad {\n' +
  '  UILabel *label = [UILabel new];\n' +
  '}\n' +
  '@end\n';

test('the packager check fails a host app target that carries a fixture launch argument', () => {
  const result = runPackagerCheck(fixtureRunnerRoot(HOST_APP_WITH_FIXTURE_SCREEN));
  assert.equal(result.ok, false, 'removing the guard makes this pass while shipping fixture code');
  assert.match(result.output, /--agent-device-\* fixture/);
  assert.match(result.output, /AgentDeviceRunnerApp\.m/);
});

test('the packager check passes the host app target once the fixture screen moved out', () => {
  const result = runPackagerCheck(fixtureRunnerRoot(HOST_APP_WITHOUT_FIXTURE_SCREEN));
  assert.equal(result.ok, true, result.output);
});
