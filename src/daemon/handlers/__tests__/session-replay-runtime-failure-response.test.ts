import { test, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../core/dispatch.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../core/dispatch.ts')>();
  return { ...actual, dispatchCommand: vi.fn(async () => ({})), resolveTargetDevice: vi.fn() };
});
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runReplayScriptFile } from '../session-replay-runtime.ts';
import { SessionStore } from '../../session-store.ts';
import { dispatchCommand } from '../../../core/dispatch.ts';
import { makeIosSession } from '../../../__tests__/test-utils/session-factories.ts';
import {
  baseReplayRequest as baseReq,
  writeReplayFile,
} from './session-replay-runtime.fixtures.ts';

const mockDispatchCommand = vi.mocked(dispatchCommand);

beforeEach(() => {
  mockDispatchCommand.mockReset();
  mockDispatchCommand.mockResolvedValue({});
});
test('divergence cause and action strings pass through the central redactor at construction', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-replay-divergence-redact-'));
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  const sessionName = 'default';
  sessionStore.set(sessionName, makeIosSession(sessionName));
  const filePath = writeReplayFile(root, ['click "Save"']);
  mockDispatchCommand.mockRejectedValue(new Error('no device runner available'));

  const response = await runReplayScriptFile({
    req: baseReq({ positionals: [filePath] }),
    sessionName,
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    invoke: async () => ({
      ok: false,
      error: {
        code: 'COMMAND_FAILED',
        message: 'request rejected: api_key=sk-live-abc123def456 invalid',
      },
    }),
  });

  expect(response.ok).toBe(false);
  if (response.ok) return;
  const divergence = response.error.details?.divergence as Record<string, unknown>;
  const cause = divergence.cause as { message: string };
  expect(cause.message).not.toContain('sk-live-abc123def456');
  expect(cause.message).toContain('api_key=[REDACTED]');
});

// --- Blocker 1: fill text must NEVER appear in the divergence output ---

test('a fill divergence never serializes the typed text at any response level', async () => {
  const sentinel = 'SuperSecretPassword-do-not-leak-12345';
  for (const level of ['digest', 'default', 'full'] as const) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-replay-fill-leak-'));
    const sessionStore = new SessionStore(path.join(root, 'sessions'));
    const sessionName = 'default';
    sessionStore.set(sessionName, makeIosSession(sessionName, { appBundleId: 'com.example.app' }));
    const filePath = writeReplayFile(root, [`fill 'label="Email"' ${JSON.stringify(sentinel)}`]);
    // Selector miss forces the divergence on the fill step; the failure
    // message is a realistic selector error, not an echo of the typed text.
    mockDispatchCommand.mockRejectedValue(new Error('no device runner available'));

    const response = await runReplayScriptFile({
      req: baseReq({ positionals: [filePath], meta: { responseLevel: level } }),
      sessionName,
      logPath: path.join(root, 'daemon.log'),
      sessionStore,
      invoke: async (req) => {
        if (req.command === 'fill') {
          // A REAL fill-verification failure carries the entered text in
          // details.expected (unmasked fields do, by the fill-diagnostics
          // contract) — the divergence transport must strip it categorically.
          return {
            ok: false,
            error: {
              code: 'COMMAND_FAILED',
              message: 'Android fill verification failed',
              details: {
                expected: sentinel,
                actual: sentinel.slice(0, 10),
                failureReason: 'text_mismatch',
              },
            },
          };
        }
        return { ok: true, data: {} };
      },
    });

    expect(response.ok).toBe(false);
    if (response.ok) return;
    const serializedDivergence = JSON.stringify(response.error.details?.divergence);
    expect(serializedDivergence).not.toContain(sentinel);
    // The WHOLE public error (flat details incl. the cause's own
    // details.expected/actual, positionals, message) must not leak it either.
    expect(JSON.stringify(response.error)).not.toContain(sentinel);
    expect(JSON.stringify(response.error)).not.toContain(sentinel.slice(0, 10));
    // The action label still names the field, with the text categorically hidden.
    const divergence = response.error.details?.divergence as { action: string };
    expect(divergence.action).toContain('<text>');
    expect(divergence.action).toContain('Email');
  }
});

// --- Blocker 3a: capture-error screen hint is sanitized ---

test('a capture-failed screen hint redacts a secret in the capture error', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-replay-screen-redact-'));
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  const sessionName = 'default';
  sessionStore.set(sessionName, makeIosSession(sessionName, { appBundleId: 'com.example.app' }));
  const filePath = writeReplayFile(root, ['click "Save"']);
  // The post-failure snapshot capture throws with a secret-bearing message.
  mockDispatchCommand.mockRejectedValue(new Error('snapshot failed: api_key=sk-live-abc123def456'));

  const response = await runReplayScriptFile({
    req: baseReq({ positionals: [filePath] }),
    sessionName,
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    invoke: async () => ({
      ok: false,
      error: { code: 'COMMAND_FAILED', message: 'Selector did not match' },
    }),
  });

  expect(response.ok).toBe(false);
  if (response.ok) return;
  const divergence = response.error.details?.divergence as {
    screen: { state: string; reason?: string; hint?: string };
  };
  expect(divergence.screen.state).toBe('unavailable');
  expect(divergence.screen.reason).toBe('capture-failed');
  expect(divergence.screen.hint).not.toContain('sk-live-abc123def456');
  expect(divergence.screen.hint).toContain('[REDACTED]');
});

// --- Expanded replay variables are never serialized (ADR 0012) ---

test('an expanded ${VAR} value echoed by a selector error never reaches the public divergence', async () => {
  const sentinel = 'ExpandedVarSecret-98765-do-not-leak';
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-replay-var-leak-'));
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  const sessionName = 'default';
  sessionStore.set(sessionName, makeIosSession(sessionName, { appBundleId: 'com.example.app' }));
  const filePath = writeReplayFile(root, ['press label="${SECRET}"']);
  mockDispatchCommand.mockRejectedValue(new Error('no device runner available'));

  const response = await runReplayScriptFile({
    req: baseReq({ positionals: [filePath], flags: { replayEnv: [`SECRET=${sentinel}`] } }),
    sessionName,
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    invoke: async (req) => {
      if (req.command === 'press') {
        // A real selector miss echoes the RESOLVED (expanded) selector.
        return {
          ok: false,
          error: {
            code: 'COMMAND_FAILED',
            message: `Selector did not match: ${req.positionals?.[0] ?? ''}`,
            hint: `Run find "${sentinel}" for contains matching.`,
          },
        };
      }
      return { ok: true, data: {} };
    },
  });

  expect(response.ok).toBe(false);
  if (response.ok) return;
  // The expanded value appears nowhere in the whole public error.
  expect(JSON.stringify(response.error)).not.toContain(sentinel);
  // The scrub is a marker replacement, not a drop: the caller still sees
  // WHICH variable the selector interpolated.
  const divergence = response.error.details?.divergence as {
    cause: { message: string; hint?: string };
  };
  expect(divergence.cause.message).toContain('<var:SECRET>');
  expect(divergence.cause.hint).toContain('<var:SECRET>');
  expect(response.error.message).toContain('<var:SECRET>');
});

test('an expanded built-in AD_DEVICE_ID never reaches the public divergence', async () => {
  const deviceId = 'BuiltInDeviceId-486b3d4c-8f92-4dc0-b5c6-unique';
  const sessionName = 'static-session-context';
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-replay-builtin-var-leak-'));
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  sessionStore.set(sessionName, makeIosSession(sessionName, { appBundleId: 'com.example.app' }));
  const filePath = writeReplayFile(root, ['press label="${AD_DEVICE_ID}"']);
  mockDispatchCommand.mockRejectedValue(new Error('no device runner available'));

  const response = await runReplayScriptFile({
    req: baseReq({ positionals: [filePath], flags: { serial: deviceId } }),
    sessionName,
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    invoke: async (req) => ({
      ok: false,
      error: {
        code: 'COMMAND_FAILED',
        message: `Device ${req.positionals?.[0] ?? ''} failed in ${sessionName} context.`,
      },
    }),
  });

  expect(response.ok).toBe(false);
  if (response.ok) return;
  expect(JSON.stringify(response.error)).not.toContain(deviceId);
  expect(response.error.message).toContain('<var:AD_DEVICE_ID>');
  // AD_SESSION was not expanded, so matching static text remains readable.
  expect(response.error.message).toContain(sessionName);
});
