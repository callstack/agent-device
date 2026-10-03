import { parseAllDocuments } from 'yaml';
import { expect, test } from 'vitest';
import type { SessionAction } from '@agent-device/contracts/session';
import {
  executeMaestroFlow,
  exportReplayActionsToMaestro,
  inspectMaestroFlow,
} from '../../index.ts';
import { createMaestroRuntimePort, makeOperations } from './runtime-port-fixtures.ts';

test.each(['tel:+15551234567', 'mailto:agent@example.test'])(
  'exports standalone deep link %s without an app config',
  (link) => {
    const result = exportReplayActionsToMaestro([action('open', [link])], {
      resolveSelector: () => null,
    });

    expect(result.yaml).toBe(`- openLink: ${link}\n`);
    expect(result.warnings).toEqual([]);
  },
);

test.each([
  ['android', 'tel:+15551234567'],
  ['android', 'mailto:agent@example.test'],
  ['ios', 'tel:+15551234567'],
  ['ios', 'mailto:agent@example.test'],
] as const)('exports and executes %s deep link %s in both open forms', async (platform, link) => {
  const result = exportReplayActionsToMaestro(
    [
      action('open', [link]),
      {
        ...action('open', ['com.example.app', link]),
        flags: { relaunch: true, clearAppState: true, launchArgs: ['--fixture'] },
      },
    ],
    { resolveSelector: () => null },
  );
  const launchApp = {
    appId: 'com.example.app',
    stopApp: true,
    clearState: true,
    launchArguments: ['--fixture'],
  };

  expect(parseYamlDocs(result.yaml)).toEqual([
    { appId: 'com.example.app' },
    [{ openLink: link }, { launchApp }, { openLink: link }],
  ]);
  expect(result.warnings).toEqual([]);

  const calls: unknown[] = [];
  const port = createMaestroRuntimePort(
    makeOperations({
      platform,
      launchApp: async (input) => {
        calls.push({ launchApp: input });
      },
      openLink: async (input) => {
        calls.push({ openLink: input });
      },
    }),
  );
  const outcome = await executeMaestroFlow(inspectMaestroFlow(result.yaml, 'links.yaml'), port, {
    platform,
    readSource: () => {
      throw new Error('unexpected flow include');
    },
  });

  expect(outcome).toMatchObject({ ok: true, replayed: 3 });
  expect(calls).toEqual([
    { openLink: { link } },
    { launchApp: { ...launchApp, launchArguments: { kind: 'list', values: ['--fixture'] } } },
    { openLink: { link } },
  ]);
});

test.each(['android', 'ios'] as const)(
  'exports an app-to-home-to-app journey that executes in order on %s',
  async (platform) => {
    const result = exportReplayActionsToMaestro(
      [action('open', ['com.example.app']), action('home'), action('open', ['com.example.app'])],
      { resolveSelector: () => null },
    );

    expect(parseYamlDocs(result.yaml)).toEqual([
      { appId: 'com.example.app' },
      [
        { launchApp: { appId: 'com.example.app' } },
        { pressKey: 'Home' },
        { launchApp: { appId: 'com.example.app' } },
      ],
    ]);
    expect(result.warnings).toEqual([]);

    const calls: string[] = [];
    const port = createMaestroRuntimePort(
      makeOperations({
        platform,
        launchApp: async ({ appId }) => {
          calls.push(`open ${appId}`);
        },
        pressKey: async ({ key }) => {
          calls.push(key);
        },
      }),
    );
    const outcome = await executeMaestroFlow(inspectMaestroFlow(result.yaml, 'home.yaml'), port, {
      platform,
      readSource: () => {
        throw new Error('unexpected flow include');
      },
    });

    expect(outcome).toMatchObject({ ok: true, replayed: 3 });
    expect(calls).toEqual(['open com.example.app', 'home', 'open com.example.app']);
  },
);

test.each(['android', 'ios'] as const)(
  'exports app switches, relaunch options, and deep links in order on %s',
  async (platform) => {
    const result = exportReplayActionsToMaestro(
      [
        action('open', ['com.example.shop']),
        action('open', ['com.example.auth']),
        {
          ...action('open', ['com.example.auth', 'example://approve']),
          flags: { relaunch: true, clearAppState: true },
        },
        action('open', ['com.example.shop']),
      ],
      { resolveSelector: () => null },
    );

    expect(parseYamlDocs(result.yaml)[0]).toEqual({ appId: 'com.example.shop' });
    expect(result.warnings).toEqual([]);

    const calls: unknown[] = [];
    const port = createMaestroRuntimePort(
      makeOperations({
        platform,
        launchApp: async (input) => {
          calls.push({ launchApp: input });
        },
        openLink: async (input) => {
          calls.push({ openLink: input });
        },
      }),
    );
    const outcome = await executeMaestroFlow(inspectMaestroFlow(result.yaml, 'apps.yaml'), port, {
      platform,
      readSource: () => {
        throw new Error('unexpected flow include');
      },
    });

    expect(outcome).toMatchObject({ ok: true, replayed: 5 });
    expect(calls).toEqual([
      { launchApp: { appId: 'com.example.shop' } },
      { launchApp: { appId: 'com.example.auth' } },
      { launchApp: { appId: 'com.example.auth', stopApp: true, clearState: true } },
      { openLink: { link: 'example://approve' } },
      { launchApp: { appId: 'com.example.shop' } },
    ]);
  },
);

test('preserves launch options, deep links, back, and keyboard exports', () => {
  const result = exportReplayActionsToMaestro(
    [
      {
        ...action('open', ['com.example.app', 'example://checkout']),
        flags: { relaunch: true, clearAppState: true, launchArgs: ['--fixture'] },
      },
      action('back'),
      action('keyboard', ['dismiss']),
      action('keyboard', ['enter']),
      action('keyboard', ['return']),
      action('open', ['example://done']),
    ],
    { resolveSelector: () => null },
  );

  expect(parseYamlDocs(result.yaml)).toEqual([
    { appId: 'com.example.app' },
    [
      {
        launchApp: {
          appId: 'com.example.app',
          stopApp: true,
          clearState: true,
          launchArguments: ['--fixture'],
        },
      },
      { openLink: 'example://checkout' },
      'back',
      'hideKeyboard',
      { pressKey: 'Enter' },
      { pressKey: 'Enter' },
      { openLink: 'example://done' },
    ],
  ]);
  expect(result.warnings).toEqual([]);
});

test.each([
  { command: 'close', positionals: [], message: 'close has no Maestro equivalent' },
  { command: 'keyboard', positionals: ['status'], message: 'keyboard status' },
  { command: 'open', positionals: [], message: 'open requires an app id or URL' },
  {
    command: 'open',
    positionals: ['com.example.app', 'another-app'],
    message: 'open with a non-URL second argument is unsupported',
  },
  ...['tel:', 'mailto:', 'http:/x', 'example://path with spaces'].map((target) => ({
    command: 'open',
    positionals: ['com.example.app', target],
    message: 'open with a non-URL second argument is unsupported',
  })),
])('rejects unsupported navigation: $command $positionals', ({ command, positionals, message }) => {
  expect(() =>
    exportReplayActionsToMaestro([action(command, positionals)], {
      actionLines: [7],
      resolveSelector: () => null,
    }),
  ).toThrowError(
    expect.objectContaining({
      code: 'INVALID_ARGS',
      details: { unsupported: [expect.objectContaining({ line: 7, message })] },
    }),
  );
});

function action(command: string, positionals: string[] = []): SessionAction {
  return { ts: 0, command, positionals, flags: {} };
}

function parseYamlDocs(script: string): unknown[] {
  return parseAllDocuments(script).map((document) => document.toJSON());
}
