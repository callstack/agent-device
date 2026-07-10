import { describe, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CliFlags } from '../../cli/parser/cli-flags.ts';
import { parseArgs } from '../../cli/parser/args.ts';
import { createAgentDeviceClient } from '../../client/client.ts';
import type { DaemonRequest, DaemonResponse } from '../../kernel/contracts.ts';
import { readMetroSessionHints, writeMetroSessionHints } from '../../metro/metro-session-hints.ts';
import { openCommandFacet } from './app.ts';

function flags(overrides: Partial<CliFlags> = {}): CliFlags {
  return overrides as CliFlags;
}

function tempStateDir(): string {
  const dir = path.join(os.tmpdir(), `agent-device-app-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function createOpenClient(params: { stateDir: string; session: string; sessionReused?: boolean }) {
  const calls: Array<Omit<DaemonRequest, 'token'>> = [];
  const client = createAgentDeviceClient(
    { session: params.session, stateDir: params.stateDir },
    {
      transport: async (req) => {
        calls.push(req);
        return {
          ok: true,
          data: { sessionReused: params.sessionReused ?? false },
        } satisfies DaemonResponse;
      },
    },
  );
  return { client, calls };
}

describe('open command metro session hints', () => {
  test('CLI parser accepts --metro-host/--metro-port/--bundle-url/--launch-url on open', () => {
    const parsed = parseArgs(
      [
        'open',
        'MyApp',
        '--metro-host',
        '127.0.0.1',
        '--metro-port',
        '8082',
        '--bundle-url',
        'http://127.0.0.1:8082/index.bundle',
        '--launch-url',
        'myapp://home',
      ],
      { strictFlags: true },
    );
    expect(parsed.flags.metroHost).toBe('127.0.0.1');
    expect(parsed.flags.metroPort).toBe(8082);
    expect(parsed.flags.bundleUrl).toBe('http://127.0.0.1:8082/index.bundle');
    expect(parsed.flags.launchUrl).toBe('myapp://home');
  });

  test('openCliReader threads the flat hint flags into command input', () => {
    const input = openCommandFacet.cliReader(
      ['MyApp'],
      flags({
        metroHost: '127.0.0.1',
        metroPort: 8082,
        bundleUrl: 'http://127.0.0.1:8082/index.bundle',
        launchUrl: 'myapp://home',
      }),
    );
    expect(input).toMatchObject({
      app: 'MyApp',
      metroHost: '127.0.0.1',
      metroPort: 8082,
      bundleUrl: 'http://127.0.0.1:8082/index.bundle',
      launchUrl: 'myapp://home',
    });
  });

  test('open folds the flat hint fields into a single session-scoped runtime object on the daemon request', async () => {
    const stateDir = tempStateDir();
    try {
      const { client, calls } = createOpenClient({ stateDir, session: 'proj-a' });
      const cliInput = openCommandFacet.cliReader(
        ['MyApp'],
        flags({
          metroHost: '127.0.0.1',
          metroPort: 8082,
          bundleUrl: 'http://127.0.0.1:8082/index.bundle',
        }),
      );
      await openCommandFacet.definition.invoke(client, cliInput);

      expect(calls).toHaveLength(1);
      expect(calls[0]?.command).toBe('open');
      expect(calls[0]?.runtime).toEqual({
        metroHost: '127.0.0.1',
        metroPort: 8082,
        bundleUrl: 'http://127.0.0.1:8082/index.bundle',
        launchUrl: undefined,
      });
      expect(calls[0]?.flags).not.toHaveProperty('metroHost');
      expect(calls[0]?.flags).not.toHaveProperty('metroPort');
      expect(calls[0]?.flags).not.toHaveProperty('bundleUrl');
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  test('open omits runtime entirely when no hint flags are given', async () => {
    const stateDir = tempStateDir();
    try {
      const { client, calls } = createOpenClient({ stateDir, session: 'proj-a' });
      const cliInput = openCommandFacet.cliReader(['MyApp'], flags({}));
      await openCommandFacet.definition.invoke(client, cliInput);

      expect(calls).toHaveLength(1);
      expect(calls[0]?.runtime).toBeUndefined();
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  test('open with hint flags records the session dev-server binding for metro reload', async () => {
    const stateDir = tempStateDir();
    try {
      const { client } = createOpenClient({ stateDir, session: 'proj-a' });
      const cliInput = openCommandFacet.cliReader(
        ['MyApp'],
        flags({
          metroHost: '127.0.0.1',
          metroPort: 8082,
          bundleUrl: 'http://127.0.0.1:8082/index.bundle',
        }),
      );
      await openCommandFacet.definition.invoke(client, cliInput);

      expect(readMetroSessionHints({ stateDir, session: 'proj-a' })).toEqual({
        metroHost: '127.0.0.1',
        metroPort: 8082,
        bundleUrl: 'http://127.0.0.1:8082/index.bundle',
      });
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  test('a hintless open that creates the session clears a leftover same-name binding', async () => {
    const stateDir = tempStateDir();
    try {
      writeMetroSessionHints({
        stateDir,
        session: 'proj-a',
        hints: { metroHost: '127.0.0.1', metroPort: 8083 },
      });
      const { client } = createOpenClient({ stateDir, session: 'proj-a', sessionReused: false });
      await openCommandFacet.definition.invoke(
        client,
        openCommandFacet.cliReader(['MyApp'], flags({})),
      );

      expect(readMetroSessionHints({ stateDir, session: 'proj-a' })).toBeUndefined();
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  test('a hintless open on an existing session keeps the current binding', async () => {
    const stateDir = tempStateDir();
    try {
      writeMetroSessionHints({
        stateDir,
        session: 'proj-a',
        hints: { metroHost: '127.0.0.1', metroPort: 8083 },
      });
      const { client } = createOpenClient({ stateDir, session: 'proj-a', sessionReused: true });
      await openCommandFacet.definition.invoke(
        client,
        openCommandFacet.cliReader(['OtherApp'], flags({})),
      );

      expect(readMetroSessionHints({ stateDir, session: 'proj-a' })).toEqual({
        metroHost: '127.0.0.1',
        metroPort: 8083,
      });
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
