import assert from 'node:assert/strict';
import { test } from 'vitest';
import { resolveCommandRecordingEffect } from '@agent-device/command-registry/registry';
import type { DispatchedCommand } from '@agent-device/contracts/command';
import { fileURLToPath } from 'node:url';

type RunnerName = string;
type RunnerCommand = { command: string; action?: string };
type RunnerTraits = {
  isReadOnlyRunnerCommand(command: RunnerCommand): boolean;
  RUNNER_COMMAND_TRAITS: Record<string, unknown>;
};

// The traits module is package-private and exports no subpath; loading it by computed file URL keeps
// this one cross-package parity check from adding a public subpath just for a test.
const { isReadOnlyRunnerCommand, RUNNER_COMMAND_TRAITS } = (await import(
  fileURLToPath(
    new URL('../../packages/platform-apple/src/runner/runner-command-traits.ts', import.meta.url),
  )
)) as RunnerTraits;

type RegistryRequest = Pick<DispatchedCommand, 'command'> &
  Partial<Pick<DispatchedCommand, 'positionals'>>;

// The runner owns no mapping to the registry, so this is the one declared place that pairs each
// runner wire command with the registry request that issues it. A runner command with no counterpart
// is runner-internal plumbing: it must be listed in RUNNER_INTERNAL and is checked on its own.
const REGISTRY_COUNTERPART: Record<RunnerName, RegistryRequest> = {
  tap: { command: 'press' },
  mouseClick: { command: 'click' },
  longPress: { command: 'longpress' },
  drag: { command: 'swipe' },
  remotePress: { command: 'tv-remote' },
  type: { command: 'type' },
  swipe: { command: 'swipe' },
  scroll: { command: 'scroll' },
  desktopScroll: { command: 'scroll' },
  findText: { command: 'find', positionals: ['text', 'x', 'exists'] },
  querySelector: { command: 'is' },
  readText: { command: 'get' },
  snapshot: { command: 'snapshot' },
  screenshot: { command: 'screenshot' },
  backInApp: { command: 'back' },
  backSystem: { command: 'back' },
  home: { command: 'home' },
  rotate: { command: 'orientation' },
  gesture: { command: 'gesture' },
  appSwitcher: { command: 'app-switcher' },
  actionButton: { command: 'action-button' },
  keyboardDismiss: { command: 'keyboard', positionals: ['dismiss'] },
  keyboardReturn: { command: 'keyboard', positionals: ['enter'] },
  pasteboardWrite: { command: 'clipboard', positionals: ['write', 'x'] },
};

// Runner commands that drive runner or app lifecycle, not a user-visible command, with whether the
// resend gate may treat them as reads.
const RUNNER_INTERNAL: Readonly<Record<string, boolean>> = {
  status: true,
  uptime: true,
  appState: true,
  gestureViewport: true,
  sequence: false,
  shutdown: false,
  activate: false,
  terminate: false,
  targetReset: false,
};

// `record` observes the app, but starting or stopping the recorder changes runner state, so a
// restart must not resend either; the runner is stricter than the registry here on purpose.
const RUNNER_STRICTER_THAN_REGISTRY: ReadonlySet<RunnerName> = new Set([
  'recordStart',
  'recordStop',
]);

const RUNNER_COMMANDS = Object.keys(RUNNER_COMMAND_TRAITS);

test('every runner command is paired with a registry request, internal, declared stricter, or the alert case', () => {
  const declared = [
    ...Object.keys(REGISTRY_COUNTERPART),
    ...Object.keys(RUNNER_INTERNAL),
    ...RUNNER_STRICTER_THAN_REGISTRY,
    'alert',
  ].sort();
  assert.deepEqual(declared, [...RUNNER_COMMANDS].sort());
});

test('the runner read-only set equals the runner commands whose registry request observes the app', () => {
  for (const [name, request] of Object.entries(REGISTRY_COUNTERPART)) {
    const effect = resolveCommandRecordingEffect({ positionals: [], ...request, flags: {} });
    assert.equal(
      isReadOnlyRunnerCommand({ command: name }),
      effect === 'observes-app',
      `${name} -> ${request.command}`,
    );
  }
  for (const [name, readOnly] of Object.entries(RUNNER_INTERNAL)) {
    assert.equal(isReadOnlyRunnerCommand({ command: name }), readOnly, name);
  }
  for (const name of RUNNER_STRICTER_THAN_REGISTRY) {
    assert.equal(isReadOnlyRunnerCommand({ command: name }), false, name);
    assert.equal(
      resolveCommandRecordingEffect({ command: 'record', positionals: [], flags: {} }),
      'observes-app',
    );
  }
});

test('alert actions agree with the registry: only get observes', () => {
  for (const action of [undefined, 'get', 'accept', 'dismiss']) {
    const effect = resolveCommandRecordingEffect({
      command: 'alert',
      positionals: action ? [action] : [],
      flags: {},
    });
    assert.equal(
      isReadOnlyRunnerCommand({ command: 'alert', action }),
      effect === 'observes-app',
      String(action),
    );
  }
});
