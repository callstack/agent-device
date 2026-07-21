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

test('session and workflow help expose active publication and literal-secret warning', () => {
  expect(buildCommandUsageText('session')).toMatch(/session save-script \[path\] \[--force\]/);
  const workflow = buildCommandUsageText('workflow');
  expect(workflow).toMatch(/open-to-destination scripts/);
  expect(workflow).toMatch(/session save-script/);
  expect(workflow).toMatch(/Do not record passwords, tokens, or other secrets/);
});
