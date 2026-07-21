import { expect, test } from 'vitest';
import { createAgentDeviceClient } from '../../agent-device-client.ts';
import { parseArgs } from '../../cli/parser/args.ts';
import { buildCommandUsageText } from '../../cli/parser/cli-help.ts';
import type { DaemonRequest, DaemonResponse } from '../../kernel/contracts.ts';
import type { CliFlags } from '../cli-grammar/flag-types.ts';
import { sessionCommandFacet } from './session.ts';

function flags(overrides: Partial<CliFlags> = {}): CliFlags {
  return overrides as CliFlags;
}

test('session save-script reads path/force and invokes the typed client surface', async () => {
  const calls: Array<Omit<DaemonRequest, 'token'>> = [];
  const client = createAgentDeviceClient(
    { session: 'authoring' },
    {
      transport: async (req) => {
        calls.push(req);
        return {
          ok: true,
          data: { session: 'authoring', savedScript: '/tmp/screen-x.ad', actionCount: 3 },
        } satisfies DaemonResponse;
      },
    },
  );

  const input = sessionCommandFacet.cliReader(
    ['save-script', '/tmp/screen-x.ad'],
    flags({ force: true, session: 'authoring' }),
  );
  const result = await sessionCommandFacet.definition.invoke(client, input);

  expect(calls).toEqual([
    expect.objectContaining({
      command: 'session_save_script',
      session: 'authoring',
      positionals: ['/tmp/screen-x.ad'],
      flags: expect.objectContaining({ force: true }),
    }),
  ]);
  expect(result).toMatchObject({
    session: 'authoring',
    savedScript: '/tmp/screen-x.ad',
    actionCount: 3,
  });
});

test('strict CLI parsing accepts session save-script path and --force', () => {
  const parsed = parseArgs(['session', 'save-script', './screen-x.ad', '--force'], {
    strictFlags: true,
  });
  expect(parsed.positionals).toEqual(['save-script', './screen-x.ad']);
  expect(parsed.flags.force).toBe(true);
});

test('typed save-script preserves an explicitly empty path for daemon validation', async () => {
  const calls: Array<Omit<DaemonRequest, 'token'>> = [];
  const client = createAgentDeviceClient(
    { session: 'authoring' },
    {
      transport: async (req) => {
        calls.push(req);
        return {
          ok: true,
          data: { session: 'authoring', savedScript: '/tmp/default.ad', actionCount: 1 },
        } satisfies DaemonResponse;
      },
    },
  );

  await client.sessions.saveScript({ path: '' });

  expect(calls[0]?.positionals).toEqual(['']);
});

test.each([
  { positionals: ['list', './unexpected.ad'], flags: {} },
  { positionals: ['state-dir'], flags: { force: true } },
])(
  'rejects save-script-only options on session siblings',
  async ({ positionals, flags: inputFlags }) => {
    const calls: Array<Omit<DaemonRequest, 'token'>> = [];
    const client = createAgentDeviceClient(
      {},
      {
        transport: async (req) => {
          calls.push(req);
          return { ok: true, data: {} } satisfies DaemonResponse;
        },
      },
    );
    const input = sessionCommandFacet.cliReader(positionals, flags(inputFlags));

    await expect(sessionCommandFacet.definition.invoke(client, input)).rejects.toThrow(
      /does not accept a path or --force/,
    );
    expect(calls).toHaveLength(0);
  },
);

test('session and workflow help expose active publication and literal-secret warning', () => {
  expect(buildCommandUsageText('session')).toMatch(/session save-script \[path\] \[--force\]/);
  const workflow = buildCommandUsageText('workflow');
  expect(workflow).toMatch(/open-to-destination scripts/);
  expect(workflow).toMatch(/session save-script/);
  expect(workflow).toMatch(/Do not record passwords, tokens, or other secrets/);
});
