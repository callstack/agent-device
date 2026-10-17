import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import type { CommandFlags } from '@agent-device/contracts/command';
import type { AgentDeviceDaemonTransport } from '@agent-device/contracts/client';
import { parseReplayScriptDetailed } from '@agent-device/ad-script';
import { SessionStore } from '@agent-device/daemon/testing/session-store';
import { isInteractiveObservation } from '@agent-device/daemon/testing/session-action-recorder';
import { makeRepairCompleteSession } from '@agent-device/daemon/testing/__tests__/support/session-factories';
import { runCliCapture } from './cli-capture.ts';
import { makeTempWorkspace } from './cli-config-fixtures.ts';
import { createAgentDeviceClient } from '../agent-device-client.ts';
import { createCommandToolExecutor } from '../mcp/command-tools.ts';
import { installIsolatedCliTestEnv } from './cli-test-env.ts';

function repairPublication(root: string) {
  const store = new SessionStore(path.join(root, 'sessions'));
  const session = makeRepairCompleteSession('default', {
    actions: [{ ts: 0, command: 'open', positionals: ['Demo'], flags: {} }],
  });
  const ref = store.publish(session.name, session);
  const transport: AgentDeviceDaemonTransport = async (req) => {
    store.recordAction(ref, {
      command: req.command,
      positionals: req.positionals,
      flags: req.flags as CommandFlags,
      interactiveObservation: isInteractiveObservation({
        ...req,
        token: 'test',
        session: 'default',
      }),
    });
    return { ok: true, data: { nodes: [] } };
  };
  return {
    session,
    transport,
    commands: () => {
      const written = store.writeSessionLog(ref);
      if (!written.written) throw new Error('expected a healed script');
      return parseReplayScriptDetailed(fs.readFileSync(written.path, 'utf8')).actions.map(
        (action) => action.command,
      );
    },
  };
}

test.each([false, true])(
  'CLI project record default retains a repair snapshot only with explicit opt-in=%s',
  async (explicit) => {
    const { root, home, project } = makeTempWorkspace();
    fs.writeFileSync(path.join(project, 'agent-device.json'), JSON.stringify({ record: true }));
    const publication = repairPublication(root);
    const result = await runCliCapture(['snapshot', '--json', ...(explicit ? ['--record'] : [])], {
      cwd: project,
      env: { HOME: home, USERPROFILE: home },
      sendToDaemon: publication.transport,
    });
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0]?.flags?.record).toBe(true);
    expect(publication.commands()).toEqual(explicit ? ['open', 'snapshot'] : ['open']);
  },
);

test.each([false, true])(
  'MCP project record default retains a repair snapshot only with explicit opt-in=%s',
  async (explicit) => {
    const { root, home, project } = makeTempWorkspace();
    fs.writeFileSync(path.join(project, 'agent-device.json'), JSON.stringify({ record: true }));
    const publication = repairPublication(root);
    const restoreEnv = installIsolatedCliTestEnv({ HOME: home, USERPROFILE: home });
    const previousCwd = process.cwd();
    process.chdir(project);
    try {
      const executor = createCommandToolExecutor({
        createClient: (config, ingress) =>
          createAgentDeviceClient(config, { ...ingress, transport: publication.transport }),
      });
      const result = await executor.execute('snapshot', explicit ? { record: true } : {});
      expect(result.isError).toBe(false);
      expect(publication.commands()).toEqual(explicit ? ['open', 'snapshot'] : ['open']);
    } finally {
      process.chdir(previousCwd);
      restoreEnv();
    }
  },
);

test('SDK per-call record explicitly retains a corrective snapshot', async () => {
  const { root } = makeTempWorkspace();
  const publication = repairPublication(root);
  const client = createAgentDeviceClient({}, { transport: publication.transport });
  await client.capture.snapshot({ record: true });
  expect(publication.commands()).toEqual(['open', 'snapshot']);
});
