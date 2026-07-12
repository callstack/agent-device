import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test, vi } from 'vitest';
import {
  invokeMaestroAssertNotVisible,
  invokeMaestroAssertVisible,
} from '../runtime-assertions.ts';
import { invokeMaestroSwipeScreen, invokeMaestroTapOn } from '../runtime-interactions.ts';
import { rememberMaestroRecoverableInteraction } from '../runtime-support.ts';
import type { DaemonRequest, DaemonResponse } from '../../../daemon/types.ts';
import type { SnapshotState } from '../../../kernel/snapshot.ts';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

test('invokeMaestroAssertVisible takes a terminal snapshot when the last miss started before the deadline', async () => {
  vi.spyOn(Date, 'now')
    .mockReturnValueOnce(0)
    .mockReturnValueOnce(1000)
    .mockReturnValueOnce(6500)
    .mockReturnValueOnce(6500)
    .mockReturnValueOnce(6600);

  let snapshots = 0;
  const response = await invokeMaestroAssertVisible({
    baseReq: {
      token: 't',
      session: 's',
      flags: { platform: 'android' },
    },
    positionals: ['id="details-preloaded"', '5000'],
    invoke: async (): Promise<DaemonResponse> => {
      snapshots += 1;
      if (snapshots === 1) {
        return { ok: true, data: { createdAt: 1, nodes: [] } };
      }
      return {
        ok: true,
        data: {
          createdAt: 2,
          nodes: [node('Details is preloaded!', { identifier: 'details-preloaded' })],
        },
      };
    },
  });

  assert.equal(response.ok, true);
  assert.equal(snapshots, 2);
  if (response.ok) {
    assert.ok(response.data);
    assert.equal(response.data.nodeLabel, 'Details is preloaded!');
    assert.equal(response.data.waitedMs, 6500);
  }
});

test('invokeMaestroAssertVisible retries transient snapshot failures until a later match', async () => {
  vi.useFakeTimers();

  let snapshots = 0;
  const responsePromise = invokeMaestroAssertVisible({
    baseReq: {
      token: 't',
      session: 's',
      flags: { platform: 'android' },
    },
    positionals: ['id="ready-state"', '1000'],
    invoke: async (): Promise<DaemonResponse> => {
      snapshots += 1;
      if (snapshots === 1) {
        return {
          ok: false,
          error: { code: 'SNAPSHOT_FAILED', message: 'Snapshot temporarily unavailable.' },
        };
      }
      return {
        ok: true,
        data: {
          createdAt: 2,
          nodes: [node('Ready', { identifier: 'ready-state' })],
        },
      };
    },
  });

  await vi.advanceTimersByTimeAsync(250);
  const response = await responsePromise;

  assert.equal(response.ok, true);
  assert.equal(snapshots, 2);
  if (response.ok) {
    assert.ok(response.data);
    assert.equal(response.data.nodeLabel, 'Ready');
    assert.equal(response.data.waitedMs, 250);
  }
});

test('invokeMaestroAssertVisible uses native wait for short simple iOS assertions', async () => {
  const calls: Array<[string, string[] | undefined]> = [];
  const response = await invokeMaestroAssertVisible({
    baseReq: {
      token: 't',
      session: 's',
      flags: { platform: 'ios' },
    },
    positionals: ['label="Ready" || text="Ready" || id="Ready"', '1000'],
    invoke: async (req): Promise<DaemonResponse> => {
      calls.push([req.command, req.positionals]);
      if (req.command === 'wait') {
        return { ok: true, data: { matches: 1 } };
      }
      return { ok: false, error: { code: 'UNEXPECTED_COMMAND', message: req.command } };
    },
  });

  assert.equal(response.ok, true);
  assert.deepEqual(calls, [['wait', ['Ready', '1000']]]);
});

test('invokeMaestroAssertVisible uses the Maestro default timeout when omitted', async () => {
  const calls: Array<[string, string[] | undefined]> = [];
  const response = await invokeMaestroAssertVisible({
    baseReq: {
      token: 't',
      session: 's',
      flags: { platform: 'ios' },
    },
    positionals: ['label="Ready" || text="Ready" || id="Ready"'],
    invoke: async (req): Promise<DaemonResponse> => {
      calls.push([req.command, req.positionals]);
      if (req.command === 'wait') {
        return { ok: true, data: { matches: 1 } };
      }
      return { ok: false, error: { code: 'UNEXPECTED_COMMAND', message: req.command } };
    },
  });

  assert.equal(response.ok, true);
  assert.deepEqual(calls, [['wait', ['Ready', '17000']]]);
});

test('invokeMaestroAssertVisible verifies Android native wait success with exact snapshot matching', async () => {
  const calls: Array<[string, string[] | undefined]> = [];
  let snapshots = 0;
  const response = await invokeMaestroAssertVisible({
    baseReq: {
      token: 't',
      session: 's',
      flags: { platform: 'android' },
    },
    positionals: ['label="Albums" || text="Albums" || id="Albums"', '1000'],
    invoke: async (req): Promise<DaemonResponse> => {
      calls.push([req.command, req.positionals]);
      if (req.command === 'wait') {
        return { ok: true, data: { matches: 1 } };
      }
      if (req.command === 'snapshot') {
        snapshots += 1;
        return {
          ok: true,
          data: snapshot([snapshots === 1 ? node('Push albums') : node('Albums')], snapshots),
        };
      }
      return { ok: false, error: { code: 'UNEXPECTED_COMMAND', message: req.command } };
    },
  });

  assert.equal(response.ok, true);
  assert.deepEqual(calls, [
    ['wait', ['Albums', '1000']],
    ['snapshot', []],
    ['snapshot', []],
  ]);
  if (response.ok) {
    assert.ok(response.data);
    assert.equal(response.data.nodeLabel, 'Albums');
  }
});

test('invokeMaestroAssertVisible falls back to one snapshot after native wait misses', async () => {
  const calls: Array<[string, string[] | undefined]> = [];
  const response = await invokeMaestroAssertVisible({
    baseReq: {
      token: 't',
      session: 's',
      flags: { platform: 'ios' },
    },
    positionals: ['label="Ready" || text="Ready" || id="Ready"', '1000'],
    invoke: async (req): Promise<DaemonResponse> => {
      calls.push([req.command, req.positionals]);
      if (req.command === 'wait') {
        return {
          ok: false,
          error: { code: 'COMMAND_FAILED', message: 'wait timed out for text: Ready' },
        };
      }
      if (req.command === 'snapshot') {
        return {
          ok: true,
          data: snapshot([node('Ready')]),
        };
      }
      return { ok: false, error: { code: 'UNEXPECTED_COMMAND', message: req.command } };
    },
  });

  assert.equal(response.ok, true);
  assert.deepEqual(calls, [
    ['wait', ['Ready', '1000']],
    ['snapshot', []],
  ]);
});

test('invokeMaestroAssertVisible re-resolves the previous Android tap when its target remains visible', async () => {
  const scope = { values: {} };
  const calls: Array<[string, string[] | undefined]> = [];
  rememberMaestroRecoverableInteraction(scope, {
    kind: 'tap',
    selector: 'label="Go to Contacts" || text="Go to Contacts" || id="Go to Contacts"',
    point: { x: 999, y: 999 },
  });

  const response = await invokeMaestroAssertVisible({
    baseReq: {
      token: 't',
      session: 's',
      flags: { platform: 'android' },
    },
    scope,
    positionals: ['label="Marissa Castillo" || text="Marissa Castillo" || id="Marissa Castillo"'],
    invoke: async (req): Promise<DaemonResponse> => {
      calls.push([req.command, req.positionals]);
      if (req.command === 'wait') {
        const waitCalls = calls.filter(([command]) => command === 'wait').length;
        if (waitCalls === 2) return { ok: true, data: { matches: 1 } };
        return {
          ok: false,
          error: { code: 'COMMAND_FAILED', message: 'wait timed out for text: Marissa Castillo' },
        };
      }
      if (req.command === 'snapshot') {
        return {
          ok: true,
          data: snapshot([
            node('Go to Contacts', {
              type: 'android.widget.Button',
              identifier: 'go-to-contacts',
            }),
          ]),
        };
      }
      if (req.command === 'click') return { ok: true, data: {} };
      return { ok: false, error: { code: 'UNEXPECTED_COMMAND', message: req.command } };
    },
  });

  assert.equal(response.ok, true);
  assert.deepEqual(calls, [
    ['wait', ['Marissa Castillo', '17000']],
    ['snapshot', []],
    ['click', ['80', '100']],
    ['wait', ['Marissa Castillo', '5000']],
  ]);
  if (response.ok) {
    assert.ok(response.data);
    assert.equal(response.data.retryTap, true);
  }
});

test('invokeMaestroAssertVisible retries previous Android text tap when point resolution misses', async () => {
  const scope = { values: {} };
  const calls: Array<[string, string[] | undefined]> = [];
  rememberMaestroRecoverableInteraction(scope, {
    kind: 'tap',
    selector: 'label="Push article" || text="Push article" || id="Push article"',
    point: { x: 999, y: 999 },
  });

  const response = await invokeMaestroAssertVisible({
    baseReq: {
      token: 't',
      session: 's',
      flags: { platform: 'android' },
    },
    scope,
    positionals: [
      'label="Article by The Doctor" || text="Article by The Doctor" || id="Article by The Doctor"',
    ],
    invoke: async (req): Promise<DaemonResponse> => {
      calls.push([req.command, req.positionals]);
      if (req.command === 'wait') {
        const waitCalls = calls.filter(([command]) => command === 'wait').length;
        if (waitCalls === 2) return { ok: true, data: { matches: 1 } };
        return {
          ok: false,
          error: {
            code: 'COMMAND_FAILED',
            message: 'wait timed out for text: Article by The Doctor',
          },
        };
      }
      if (req.command === 'snapshot') {
        return {
          ok: true,
          data: snapshot([
            node('Push article', {
              type: 'android.widget.Button',
              identifier: undefined,
              rect: undefined,
            }),
          ]),
        };
      }
      if (req.command === 'find') return { ok: true, data: {} };
      return { ok: false, error: { code: 'UNEXPECTED_COMMAND', message: req.command } };
    },
  });

  assert.equal(response.ok, true);
  assert.deepEqual(calls, [
    ['wait', ['Article by The Doctor', '17000']],
    ['snapshot', []],
    ['find', ['Push article', 'click']],
    ['wait', ['Article by The Doctor', '5000']],
  ]);
  if (response.ok) {
    assert.ok(response.data);
    assert.equal(response.data.retryTap, true);
  }
});

test('invokeMaestroAssertVisible does not retry stale Android taps after swipes', async () => {
  const scope = { values: {} };
  const calls: Array<[string, string[] | undefined]> = [];
  rememberMaestroRecoverableInteraction(scope, {
    kind: 'tap',
    selector: 'label="Contacts" || text="Contacts" || id="Contacts"',
    point: { x: 120, y: 720 },
  });

  const swipeResponse = await invokeMaestroSwipeScreen({
    baseReq: {
      token: 't',
      session: 's',
      flags: { platform: 'android' },
    },
    scope,
    positionals: ['direction', 'left', '300'],
    invoke: async (req): Promise<DaemonResponse> => {
      calls.push([req.command, req.positionals]);
      if (req.command === 'gesture') return { ok: true, data: {} };
      return { ok: false, error: { code: 'UNEXPECTED_COMMAND', message: req.command } };
    },
  });
  assert.equal(swipeResponse.ok, true);

  const response = await invokeMaestroAssertVisible({
    baseReq: {
      token: 't',
      session: 's',
      flags: { platform: 'android' },
    },
    scope,
    positionals: [
      'label="What is Lorem Ipsum?" || text="What is Lorem Ipsum?" || id="What is Lorem Ipsum?"',
      '2000',
    ],
    invoke: async (req): Promise<DaemonResponse> => {
      calls.push([req.command, req.positionals]);
      if (req.command === 'wait') {
        return {
          ok: false,
          error: {
            code: 'COMMAND_FAILED',
            message: 'wait timed out for text: What is Lorem Ipsum?',
          },
        };
      }
      if (req.command === 'snapshot') {
        return {
          ok: true,
          data: snapshot([node('Contacts'), node('Albums')]),
        };
      }
      if (req.command === 'gesture') return { ok: true, data: {} };
      return { ok: false, error: { code: 'UNEXPECTED_COMMAND', message: req.command } };
    },
  });

  assert.equal(response.ok, false);
  assert.deepEqual(calls, [
    ['gesture', []],
    ['wait', ['What is Lorem Ipsum?', '2000']],
    ['snapshot', []],
    ['gesture', []],
    ['wait', ['What is Lorem Ipsum?', '2000']],
    ['snapshot', []],
  ]);
});

test('invokeMaestroAssertVisible does not replay a previous iOS swipe after an AX miss', async () => {
  const scope = { values: {} };
  const calls: Array<[string, string[] | undefined]> = [];
  rememberMaestroRecoverableInteraction(scope, {
    kind: 'swipe',
    command: 'gesture',
    input: { kind: 'swipe', preset: 'left', durationMs: 300 },
  });

  const response = await invokeMaestroAssertVisible({
    baseReq: {
      token: 't',
      session: 's',
      flags: { platform: 'ios' },
    },
    scope,
    positionals: ['label="Second page" || text="Second page" || id="Second page"', '1000'],
    invoke: async (req): Promise<DaemonResponse> => {
      calls.push([req.command, req.positionals]);
      if (req.command === 'wait') {
        return {
          ok: false,
          error: { code: 'COMMAND_FAILED', message: 'wait timed out for text: Second page' },
        };
      }
      if (req.command === 'snapshot') return { ok: true, data: snapshot([node('First page')]) };
      return { ok: false, error: { code: 'UNEXPECTED_COMMAND', message: req.command } };
    },
  });

  assert.equal(response.ok, false);
  assert.deepEqual(calls, [
    ['wait', ['Second page', '1000']],
    ['snapshot', []],
  ]);
});

test('invokeMaestroAssertVisible does not retry stale Android taps after fuzzy taps', async () => {
  const scope = { values: {} };
  const calls: Array<[string, string[] | undefined]> = [];
  rememberMaestroRecoverableInteraction(scope, {
    kind: 'tap',
    selector: 'label="Contacts" || text="Contacts" || id="Contacts"',
    point: { x: 120, y: 720 },
  });

  const tapResponse = await invokeMaestroTapOn({
    baseReq: {
      token: 't',
      session: 's',
      flags: { platform: 'android' },
    },
    scope,
    positionals: ['label="Search" || text="Search" || id="Search"'],
    invoke: async (req): Promise<DaemonResponse> => {
      calls.push([req.command, req.positionals]);
      if (req.command === 'snapshot') return { ok: true, data: snapshot([node('Search')]) };
      if (req.command === 'click') {
        return { ok: false, error: { code: 'COMMAND_FAILED', message: 'coordinate miss' } };
      }
      if (req.command === 'find') return { ok: true, data: {} };
      return { ok: false, error: { code: 'UNEXPECTED_COMMAND', message: req.command } };
    },
  });

  assert.equal(tapResponse.ok, true);

  const response = await invokeMaestroAssertVisible({
    baseReq: {
      token: 't',
      session: 's',
      flags: { platform: 'android' },
    },
    scope,
    positionals: [
      'label="Marissa Castillo" || text="Marissa Castillo" || id="Marissa Castillo"',
      '0',
    ],
    invoke: async (req): Promise<DaemonResponse> => {
      calls.push([req.command, req.positionals]);
      if (req.command === 'wait') {
        return {
          ok: false,
          error: { code: 'COMMAND_FAILED', message: 'wait timed out for text: Marissa Castillo' },
        };
      }
      if (req.command === 'snapshot') return { ok: true, data: snapshot([node('Settings')]) };
      if (req.command === 'click') return { ok: true, data: {} };
      return { ok: false, error: { code: 'UNEXPECTED_COMMAND', message: req.command } };
    },
  });

  assert.equal(response.ok, false);
  assert.deepEqual(calls, [
    ['snapshot', []],
    ['click', ['80', '100']],
    ['find', ['Search', 'click']],
    ['wait', ['Marissa Castillo', '0']],
    ['snapshot', []],
  ]);
});

test('invokeMaestroAssertVisible does not use raw fallback for iOS snapshot misses', async () => {
  const snapshotFlags: Array<DaemonRequest['flags']> = [];
  const response = await invokeMaestroAssertVisible({
    baseReq: {
      token: 't',
      session: 's',
      flags: { platform: 'ios' },
    },
    positionals: ['id="chat"', '1000'],
    invoke: async (req): Promise<DaemonResponse> => {
      if (req.command === 'snapshot') {
        snapshotFlags.push(req.flags);
        return { ok: true, data: snapshot([]) };
      }
      return { ok: false, error: { code: 'UNEXPECTED_COMMAND', message: req.command } };
    },
  });

  assert.equal(response.ok, false);
  assert.ok(snapshotFlags.length > 1);
  assert.equal(
    snapshotFlags.some((flags) => flags?.snapshotRaw === true),
    false,
  );
});

test('invokeMaestroAssertVisible does not use raw fallback for Android identifiers', async () => {
  const snapshotFlags: Array<DaemonRequest['flags']> = [];
  const response = await invokeMaestroAssertVisible({
    baseReq: {
      token: 't',
      session: 's',
      flags: { platform: 'android' },
    },
    positionals: ['id="album-0"', '1000'],
    invoke: async (req): Promise<DaemonResponse> => {
      if (req.command === 'snapshot') {
        snapshotFlags.push(req.flags);
        return {
          ok: true,
          data: snapshot([node('Album item', { identifier: 'album-0' })]),
        };
      }
      return { ok: false, error: { code: 'UNEXPECTED_COMMAND', message: req.command } };
    },
  });

  assert.equal(response.ok, true);
  assert.equal(snapshotFlags.length, 1);
  assert.equal(snapshotFlags[0]?.snapshotRaw, undefined);
});

test('invokeMaestroAssertVisible retries Android id-only selectors with a raw snapshot after a presentation miss', async () => {
  const snapshotFlags: Array<DaemonRequest['flags']> = [];
  const response = await invokeMaestroAssertVisible({
    baseReq: {
      token: 't',
      session: 's',
      flags: { platform: 'android' },
    },
    positionals: ['id="material-top-bar-post-auth-screen"', '1000'],
    invoke: async (req): Promise<DaemonResponse> => {
      if (req.command === 'snapshot') {
        snapshotFlags.push(req.flags);
        return {
          ok: true,
          data: snapshot(
            req.flags?.snapshotRaw === true
              ? [
                  node('', {
                    type: 'android.view.ViewGroup',
                    identifier: 'material-top-bar-post-auth-screen',
                    rect: { x: 0, y: 240, width: 1080, height: 1900 },
                  }),
                ]
              : [],
          ),
        };
      }
      return { ok: false, error: { code: 'UNEXPECTED_COMMAND', message: req.command } };
    },
  });

  assert.equal(response.ok, true);
  assert.deepEqual(
    snapshotFlags.map((flags) => flags?.snapshotRaw),
    [undefined, true],
  );
});

test('invokeMaestroAssertNotVisible does not use Android raw fallback for absent id-only selectors', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(0);

  const snapshotFlags: Array<DaemonRequest['flags']> = [];
  const response = await invokeMaestroAssertNotVisible({
    baseReq: {
      token: 't',
      session: 's',
      flags: { platform: 'android' },
    },
    positionals: ['id="archived-banner"', '0'],
    invoke: async (req): Promise<DaemonResponse> => {
      if (req.command === 'snapshot') {
        snapshotFlags.push(req.flags);
        return { ok: true, data: snapshot([]) };
      }
      return { ok: false, error: { code: 'UNEXPECTED_COMMAND', message: req.command } };
    },
  });

  assert.equal(response.ok, true);
  assert.deepEqual(
    snapshotFlags.map((flags) => flags?.snapshotRaw),
    [undefined],
  );
});

test('invokeMaestroAssertVisible does not use Android raw fallback for generated text selectors', async () => {
  const snapshotFlags: Array<DaemonRequest['flags']> = [];
  const response = await invokeMaestroAssertVisible({
    baseReq: {
      token: 't',
      session: 's',
      flags: { platform: 'android' },
    },
    positionals: ['label="Chat" || text="Chat" || id="Chat"', '0'],
    invoke: async (req): Promise<DaemonResponse> => {
      if (req.command === 'snapshot') {
        snapshotFlags.push(req.flags);
        return { ok: true, data: snapshot([]) };
      }
      return { ok: false, error: { code: 'UNEXPECTED_COMMAND', message: req.command } };
    },
  });

  assert.equal(response.ok, false);
  assert.equal(
    snapshotFlags.some((flags) => flags?.snapshotRaw === true),
    false,
  );
});

test('invokeMaestroAssertVisible bounds Android verification retries after native wait succeeds', async () => {
  vi.useFakeTimers();

  const calls: Array<[string, string[] | undefined]> = [];
  const responsePromise = invokeMaestroAssertVisible({
    baseReq: {
      token: 't',
      session: 's',
      flags: { platform: 'android' },
    },
    positionals: ['label="Input" || text="Input" || id="Input"', '60000'],
    invoke: async (req): Promise<DaemonResponse> => {
      calls.push([req.command, req.positionals]);
      if (req.command === 'snapshot') {
        return { ok: true, data: snapshot([node('Loading')]) };
      }
      if (req.command === 'wait') return { ok: true, data: { matches: 1 } };
      return { ok: false, error: { code: 'UNEXPECTED_COMMAND', message: req.command } };
    },
  });

  await vi.advanceTimersByTimeAsync(6500);
  const response = await responsePromise;

  assert.equal(response.ok, false);
  assert.deepEqual(calls.slice(0, 3), [
    ['wait', ['Input', '60000']],
    ['snapshot', []],
    ['snapshot', []],
  ]);
  assert.ok(calls.filter(([command]) => command === 'snapshot').length < 40);
});

test('invokeMaestroAssertVisible writes terminal snapshot artifacts for failed attempts', async () => {
  const artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-assert-artifacts-'));
  try {
    const response = await invokeMaestroAssertVisible({
      baseReq: {
        token: 't',
        session: 's',
        flags: { platform: 'android', artifactsDir },
      },
      positionals: ['id="album-0"', '0'],
      invoke: async (): Promise<DaemonResponse> => ({
        ok: true,
        data: snapshot([
          node('Chat', { identifier: 'chat-tab', type: 'android.widget.Button' }),
          node('Contacts', { identifier: 'contacts-tab', type: 'android.widget.Button' }),
        ]),
      }),
    });

    assert.equal(response.ok, false);
    if (!response.ok) {
      const artifactPaths = response.error.details?.artifactPaths;
      assert.deepEqual(artifactPaths, [
        path.join(artifactsDir, 'failure-snapshot.json'),
        path.join(artifactsDir, 'failure-snapshot.txt'),
      ]);
    }
    assert.match(
      fs.readFileSync(path.join(artifactsDir, 'failure-snapshot.txt'), 'utf8'),
      /@e1 \[button\] "Chat"/,
    );
    assert.match(
      fs.readFileSync(path.join(artifactsDir, 'failure-snapshot.json'), 'utf8'),
      /"identifier": "chat-tab"/,
    );
  } finally {
    fs.rmSync(artifactsDir, { recursive: true, force: true });
  }
});

test('invokeMaestroAssertVisible treats an elapsed ellipsis loading gate as already past loading', async () => {
  vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValueOnce(250);

  const response = await invokeMaestroAssertVisible({
    baseReq: {
      token: 't',
      session: 's',
      flags: {
        platform: 'ios',
        maestro: { allowAlreadyPastLoading: true },
      },
    },
    positionals: ['label="Loading…" || text="Loading…" || id="Loading…"', '1000'],
    invoke: async (req): Promise<DaemonResponse> => {
      if (req.command === 'wait') {
        return {
          ok: false,
          error: { code: 'COMMAND_FAILED', message: 'wait timed out for text: Loading…' },
        };
      }
      return {
        ok: true,
        data: snapshot([node('Dashboard')]),
      };
    },
  });

  assert.equal(response.ok, true);
  if (response.ok) {
    assert.ok(response.data);
    assert.equal(response.data.alreadyPastLoading, true);
    assert.equal(response.data.timeoutMs, 1000);
  }
});

test('invokeMaestroAssertVisible reports React Native overlays during snapshot assertions', async () => {
  const calls: Array<[string, string[] | undefined]> = [];
  let snapshots = 0;
  const response = await invokeMaestroAssertVisible({
    baseReq: {
      token: 't',
      session: 's',
      flags: { platform: 'ios' },
    },
    positionals: ['label="Ready" || text="Ready" || id="Ready"', '1000'],
    invoke: async (req): Promise<DaemonResponse> => {
      calls.push([req.command, req.positionals]);
      if (req.command === 'wait') {
        return {
          ok: false,
          error: { code: 'COMMAND_FAILED', message: 'wait timed out for text: Ready' },
        };
      }
      if (req.command === 'snapshot') {
        snapshots += 1;
        return {
          ok: true,
          data: snapshot(
            snapshots === 1
              ? [
                  node('Ready'),
                  node('Runtime Error', {
                    index: 2,
                    ref: 'e2',
                    rect: { x: 0, y: 0, width: 390, height: 80 },
                  }),
                  node('Minimize', {
                    index: 3,
                    ref: 'e3',
                    type: 'Button',
                    rect: { x: 300, y: 20, width: 80, height: 44 },
                  }),
                ]
              : [node('Ready')],
            snapshots,
          ),
        };
      }
      return { ok: false, error: { code: 'UNEXPECTED_COMMAND', message: req.command } };
    },
  });

  assert.equal(response.ok, false);
  if (!response.ok) {
    assert.match(response.error.message, /React Native overlay is covering app content/);
  }
  assert.deepEqual(calls, [
    ['wait', ['Ready', '1000']],
    ['snapshot', []],
  ]);
});

test('invokeMaestroAssertVisible fails fast when a RedBox has no dismiss target', async () => {
  const calls: Array<[string, string[] | undefined]> = [];
  const response = await invokeMaestroAssertVisible({
    baseReq: {
      token: 't',
      session: 's',
      flags: { platform: 'ios' },
    },
    positionals: ['label="Ready" || text="Ready" || id="Ready"', '1000'],
    invoke: async (req): Promise<DaemonResponse> => {
      calls.push([req.command, req.positionals]);
      if (req.command === 'wait') {
        return {
          ok: false,
          error: { code: 'COMMAND_FAILED', message: 'wait timed out for text: Ready' },
        };
      }
      if (req.command === 'snapshot') {
        return {
          ok: true,
          data: snapshot([
            node("Uncaught (in promise): Error: Unable to download asset from url: 'x'", {
              type: 'Other',
              rect: { x: 0, y: 0, width: 390, height: 80 },
            }),
          ]),
        };
      }
      if (req.command === 'react-native') {
        return {
          ok: false,
          error: {
            code: 'COMMAND_FAILED',
            message: 'React Native overlay detected, but no safe dismiss target was found',
          },
        };
      }
      return { ok: false, error: { code: 'UNEXPECTED_COMMAND', message: req.command } };
    },
  });

  assert.equal(response.ok, false);
  if (!response.ok) {
    assert.match(response.error.message, /React Native overlay is covering app content/);
  }
  assert.deepEqual(calls, [
    ['wait', ['Ready', '1000']],
    ['snapshot', []],
  ]);
});

test('invokeMaestroAssertNotVisible passes after a slow hidden sample exhausts the timeout', async () => {
  vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValueOnce(3500);

  const calls: DaemonRequest[] = [];
  const response = await invokeMaestroAssertNotVisible({
    baseReq: {
      token: 't',
      session: 's',
      flags: {},
    },
    positionals: ['id="tab-4"'],
    invoke: async (req): Promise<DaemonResponse> => {
      calls.push(req);
      return {
        ok: true,
        data: {
          createdAt: 1,
          nodes: [],
        },
      };
    },
  });

  assert.equal(response.ok, true);
  assert.deepEqual(
    calls.map((call) => [call.command, call.positionals]),
    [['snapshot', []]],
  );
  if (response.ok) {
    assert.ok(response.data);
    assert.equal(response.data.stableSamples, 1);
    assert.equal(response.data.waitedMs, 3500);
  }
});

test('invokeMaestroAssertNotVisible ignores matched nodes without visible rects', async () => {
  vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValueOnce(3500);

  const response = await invokeMaestroAssertNotVisible({
    baseReq: {
      token: 't',
      session: 's',
      flags: { platform: 'android' },
    },
    positionals: ['label="📌" || text="📌" || id="📌"'],
    invoke: async (): Promise<DaemonResponse> => ({
      ok: true,
      data: {
        createdAt: 1,
        nodes: [node('📌', { value: '📌', enabled: true, depth: 21, rect: undefined })],
      },
    }),
  });

  assert.equal(response.ok, true);
  if (response.ok) {
    assert.ok(response.data);
    assert.equal(response.data.stableSamples, 1);
  }
});

function snapshot(nodes: SnapshotState['nodes'], createdAt = 1): SnapshotState {
  return { createdAt, nodes };
}

function node(
  label: string,
  overrides: Partial<SnapshotState['nodes'][number]> = {},
): SnapshotState['nodes'][number] {
  return {
    index: 1,
    ref: 'e1',
    type: 'android.widget.TextView',
    label,
    rect: { x: 20, y: 80, width: 120, height: 40 },
    depth: 8,
    ...overrides,
  };
}

test('invokeMaestroAssertNotVisible accepts timeout overrides for short extended waits', async () => {
  vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValueOnce(300);

  const response = await invokeMaestroAssertNotVisible({
    baseReq: {
      token: 't',
      session: 's',
      flags: {},
    },
    positionals: ['id="toast"', '1'],
    invoke: async (): Promise<DaemonResponse> => ({
      ok: true,
      data: {
        createdAt: 1,
        nodes: [],
      },
    }),
  });

  assert.equal(response.ok, true);
  if (response.ok) {
    assert.ok(response.data);
    assert.equal(response.data.stableSamples, 1);
    assert.equal(response.data.timeoutMs, 1);
  }
});
