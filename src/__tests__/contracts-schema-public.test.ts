import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { AppError } from '../sdk/index.ts';
import type { CommandResult } from '../core/command-descriptor/command-result.ts';
import type { AppStateCommandResult } from '../contracts/app-state.ts';
import type { ClipboardCommandResult } from '../contracts/clipboard.ts';
import type { BootCommandResult, ShutdownCommandResult } from '../contracts/device.ts';
import type {
  AppSwitcherCommandResult,
  BackCommandResult,
  HomeCommandResult,
  RotateCommandResult,
  TvRemoteCommandResult,
} from '../contracts/navigation.ts';
import type { ViewportCommandResult } from '../contracts/viewport.ts';
import { centerOfRect, defaultHintForCode, normalizeError } from '../sdk/contracts.ts';
import {
  daemonRuntimeSchema,
  jsonRpcRequestSchema,
  type AppErrorCode,
  type Rect,
  type SnapshotNode,
} from '../kernel/contracts.ts';

const invalidArgsCode = 'INVALID_ARGS' satisfies AppErrorCode;
const rect = { x: 1, y: 2, width: 3, height: 4 } satisfies Rect;
const node = {
  index: 0,
  ref: 'e1',
  type: 'Button',
  label: 'Continue',
  rect,
} satisfies SnapshotNode;

test('public contracts error helpers do not load diagnostics module', () => {
  const errorsSource = fs.readFileSync(
    path.join(import.meta.dirname, '..', 'kernel', 'errors.ts'),
    'utf8',
  );

  assert.doesNotMatch(errorsSource, /['"]\.\/diagnostics\.ts['"]/);
  assert.doesNotMatch(errorsSource, /node:/);
});

test('public contract facade does not expose parser schemas', async () => {
  const publicContracts = (await import('../sdk/contracts.ts')) as Record<string, unknown>;

  assert.equal(publicContracts.daemonCommandRequestSchema, undefined);
  assert.equal(publicContracts.daemonRuntimeSchema, undefined);
  assert.equal(publicContracts.jsonRpcRequestSchema, undefined);
  assert.equal(publicContracts.leaseAllocateSchema, undefined);
  assert.equal(publicContracts.leaseHeartbeatSchema, undefined);
  assert.equal(publicContracts.leaseReleaseSchema, undefined);
});

test('internal runtime schema validates daemon runtime hints', () => {
  const runtime = daemonRuntimeSchema.parse({
    platform: 'ios',
    metroHost: '127.0.0.1',
    metroPort: 8081,
    bundleUrl: 'https://example.test/index.bundle?platform=ios',
  });

  assert.equal(runtime.platform, 'ios');
  assert.equal(runtime.metroHost, '127.0.0.1');
  assert.deepEqual(centerOfRect(rect), { x: 3, y: 4 });
  assert.equal(node.ref, 'e1');
});

test('command result contracts are assignable to command result map', () => {
  const boot = {
    platform: 'ios',
    target: 'mobile',
    device: 'iPhone 17',
    id: 'booted-device',
    kind: 'simulator',
    booted: true,
  } satisfies BootCommandResult;
  const bootFromMap: CommandResult<'boot'> = boot;

  const shutdown = {
    platform: 'ios',
    target: 'mobile',
    device: 'iPhone 17',
    id: 'shutdown-device',
    kind: 'simulator',
    shutdown: {
      success: true,
      exitCode: 0,
      stdout: '',
      stderr: '',
    },
  } satisfies ShutdownCommandResult;
  const shutdownFromMap: CommandResult<'shutdown'> = shutdown;

  const viewport = {
    width: 390,
    height: 844,
    message: 'Viewport is 390x844',
  } satisfies ViewportCommandResult;
  const viewportFromMap: CommandResult<'viewport'> = viewport;

  const back = {
    action: 'back',
    mode: 'in-app',
    message: 'Back',
  } satisfies BackCommandResult;
  const backFromMap: CommandResult<'back'> = back;

  const home = {
    action: 'home',
    message: 'Home',
  } satisfies HomeCommandResult;
  const homeFromMap: CommandResult<'home'> = home;

  const appSwitcher = {
    action: 'app-switcher',
    message: 'App switcher opened',
  } satisfies AppSwitcherCommandResult;
  const appSwitcherFromMap: CommandResult<'app-switcher'> = appSwitcher;

  const rotate = {
    action: 'rotate',
    orientation: 'portrait',
    message: 'Rotated to portrait',
  } satisfies RotateCommandResult;
  const rotateFromMap: CommandResult<'rotate'> = rotate;

  const tvRemote = {
    action: 'tv-remote',
    button: 'select',
    message: 'Pressed TV remote select',
  } satisfies TvRemoteCommandResult;
  const tvRemoteFromMap: CommandResult<'tv-remote'> = tvRemote;

  const clipboard = {
    action: 'write',
    textLength: 11,
    message: 'Clipboard updated',
  } satisfies ClipboardCommandResult;
  const clipboardFromMap: CommandResult<'clipboard'> = clipboard;

  const appstate = {
    platform: 'android',
    package: 'com.example.demo',
    activity: 'com.example.demo.MainActivity',
  } satisfies AppStateCommandResult;
  const appstateFromMap: CommandResult<'appstate'> = appstate;

  assert.equal(bootFromMap.booted, true);
  assert.equal(shutdownFromMap.shutdown.success, true);
  assert.equal(viewportFromMap.width, 390);
  assert.equal(backFromMap.mode, 'in-app');
  assert.equal(homeFromMap.action, 'home');
  assert.equal(appSwitcherFromMap.action, 'app-switcher');
  assert.equal(rotateFromMap.orientation, 'portrait');
  assert.equal(tvRemoteFromMap.button, 'select');
  assert.equal(clipboardFromMap.action === 'write' ? clipboardFromMap.textLength : -1, 11);
  assert.equal(
    appstateFromMap.platform === 'android' ? appstateFromMap.package : '',
    'com.example.demo',
  );
});

test('public contract exports normalize and hint app errors', () => {
  const normalized = normalizeError(new AppError(invalidArgsCode, 'Invalid command'));

  assert.equal(normalized.code, invalidArgsCode);
  assert.equal(normalized.hint, defaultHintForCode(invalidArgsCode));
  assert.equal(
    defaultHintForCode('UNKNOWN'),
    'Unexpected internal error. Retry with --debug and report the diagnostics log if it persists.',
  );
});

test('internal JSON-RPC schema rejects invalid payloads', () => {
  assert.throws(
    () =>
      jsonRpcRequestSchema.parse({
        jsonrpc: '2.0',
        id: {},
        method: 'agent_device.command',
      }),
    /\.id/,
  );
});
