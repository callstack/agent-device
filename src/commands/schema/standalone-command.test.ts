import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, test } from 'vitest';
import { createTestHostEnvironment, mkdtempForTestSync } from '@agent-device/test-kit';
import {
  projectStandaloneCommand,
  STANDALONE_COMMAND_OPTIONS,
} from '@agent-device/command-registry/standalone-command';
import { resolveCommandCompositeResourceTrait } from '@agent-device/command-registry/registry';
import { isFlagSupportedForCommand } from './option-schema.ts';
import {
  parsePerfRuntimeRequest,
  formatPerfRuntimeRequestArgs,
} from '@agent-device/capture-kit/perf-runtime-plan';
import {
  parseAudioProbeRequest,
  formatAudioProbeRequestArgs,
} from '@agent-device/contracts/audio-runtime-plan';
import { buildRequestFlags } from '../command-flags.ts';
import { prepareDaemonCommandRequest } from '../command-projection.ts';
import { readInputFromCli } from '../cli-grammar.ts';
import { parseArgs } from '../../cli/parser/args.ts';
import type { CommandFlags } from '@agent-device/contracts/command';

function shellArgv(command: string): string[] {
  const shell = spawnSync('sh', ['-c', 'eval "set -- $1"; printf "%s\\0" "$@"', 'sh', command], {
    encoding: 'buffer',
  });
  expect(shell.status, shell.stderr.toString()).toBe(0);
  return shell.stdout.toString().split('\0').slice(0, -1);
}

function publicForm(command: string, positionals: string[], flags: CommandFlags) {
  if (command === 'audio')
    return {
      positionals: formatAudioProbeRequestArgs(parseAudioProbeRequest(positionals), positionals),
      options: {},
    };
  if (command !== 'perf') return undefined;
  return formatPerfRuntimeRequestArgs(
    parsePerfRuntimeRequest({
      positionals,
      kind: flags.kind,
      outPath: flags.out,
    }),
  );
}

test('projection rows match the strict CLI owner and cover active resource traits', () => {
  for (const [command, keys] of Object.entries(STANDALONE_COMMAND_OPTIONS)) {
    for (const key of keys) expect(isFlagSupportedForCommand(key, command)).toBe(true);
  }
  for (const command of ['perf', 'record', 'logs', 'audio', 'trace']) {
    expect(resolveCommandCompositeResourceTrait(command)).toBe('operation');
    expect(STANDALONE_COMMAND_OPTIONS).toHaveProperty(command);
  }
  expect(resolveCommandCompositeResourceTrait('test')).toBe('nested-test');
  expect(STANDALONE_COMMAND_OPTIONS).toHaveProperty('test');
});

test('real writers and the strict public parser round-trip refused operation commands', async () => {
  const dir = mkdtempForTestSync('standalone-projection-');
  const canary = path.join(dir, 'executed');
  const session = "demo's session; $(false)";
  const host = createTestHostEnvironment({ cwd: dir, env: {} });
  const rows = [
    [
      'record',
      { action: 'start', path: `clips/demo; $(touch ${canary}).mp4`, fps: 30, hideTouches: true },
    ],
    ['logs', { action: 'clear', restart: true }],
    ['audio', { action: 'probe', probeAction: 'start', durationMs: 2000, bucketMs: 100 }],
    ['trace', { action: 'start', path: 'trace file; $HOME' }],
    [
      'perf',
      {
        area: 'cpu',
        subject: 'profile',
        action: 'start',
        kind: 'xctrace',
        template: 'Time Profiler; $HOME',
        out: 'profile trace; $HOME',
      },
    ],
    ['perf', { area: 'trace', action: 'start', kind: 'perfetto', out: 'a b' }],
    ['perf', { area: 'memory', action: 'snapshot', kind: 'android-hprof', out: 'snapshot file' }],
  ] as const;
  for (const [command, input] of rows) {
    const written = await prepareDaemonCommandRequest(command, input, host);
    const flags = buildRequestFlags(written.options, written.metadataFlags);
    const projection = projectStandaloneCommand(
      { command, positionals: written.positionals, flags, session },
      publicForm(command, written.positionals, flags),
    );
    expect(projection.standaloneCommand, command).toBeDefined();
    const argv = shellArgv(projection.standaloneCommand!);
    expect(argv[0]).toBe('agent-device');
    const parsed = parseArgs(argv.slice(1), { strictFlags: true });
    expect(parsed.command).toBe(command);
    expect(parsed.flags.session).toBe(session);
    const rewrittenInput = readInputFromCli(command, parsed.positionals, parsed.flags);
    const rewritten = await prepareDaemonCommandRequest(command, rewrittenInput, host);
    expect(rewritten.positionals).toEqual(written.positionals);
    const rewrittenFlags = buildRequestFlags(rewritten.options, rewritten.metadataFlags);
    for (const key of STANDALONE_COMMAND_OPTIONS[command])
      expect(rewrittenFlags[key], `${command}.${key}`).toEqual(flags[key]);
  }
  expect(fs.existsSync(canary)).toBe(false);
});

test('test suite projection uses its original paths, backend, and live outer session', async () => {
  const dir = mkdtempForTestSync('standalone-test-');
  const script = path.join(dir, 'suite a b.ad');
  fs.writeFileSync(script, 'home\n');
  const host = createTestHostEnvironment({ cwd: dir, env: {} });
  const written = await prepareDaemonCommandRequest(
    'test',
    { paths: [script], timeoutMs: 5000 },
    host,
  );
  const flags = buildRequestFlags(written.options, written.metadataFlags);
  const result = projectStandaloneCommand({
    command: 'test',
    positionals: written.positionals,
    flags,
    session: 'outer session',
  });
  expect(result.standaloneCommand).toBeDefined();
  const parsed = parseArgs(shellArgv(result.standaloneCommand!).slice(1), { strictFlags: true });
  expect(parsed).toMatchObject({
    command: 'test',
    positionals: [script],
    flags: { session: 'outer session', timeoutMs: 5000 },
  });
  const rewritten = await prepareDaemonCommandRequest(
    'test',
    readInputFromCli('test', parsed.positionals, parsed.flags),
    host,
  );
  expect(rewritten.positionals).toEqual(written.positionals);
});

test('secret and unrepresentable input omits the executable string', () => {
  const base = { command: 'record', session: 'safe session', positionals: ['start'] };
  expect(
    projectStandaloneCommand({
      ...base,
      positionals: ['start', 'https://user:secret@example.com/a'],
    }),
  ).toEqual({ standaloneCommandOmitted: 'secret-bearing' });
  expect(
    projectStandaloneCommand({
      ...base,
      positionals: ['start', 'https://example.com/a?token=secret'],
    }),
  ).toEqual({ standaloneCommandOmitted: 'secret-bearing' });
  expect(projectStandaloneCommand({ ...base, positionals: ['start', 'a\r\nb'] })).toEqual({
    standaloneCommandOmitted: 'secret-bearing',
  });
  expect(projectStandaloneCommand({ ...base, flags: { session: 'other' } })).toEqual({
    standaloneCommandOmitted: 'not-cli-representable',
  });
  expect(
    projectStandaloneCommand({ ...base, flags: { unexpected: 'value' } as CommandFlags }),
  ).toEqual({ standaloneCommandOmitted: 'not-cli-representable' });
  expect(
    projectStandaloneCommand({
      command: 'test',
      session: 'safe',
      positionals: ['suite.ad'],
      flags: { replayEnv: ['TOKEN=secret'] },
    }),
  ).toEqual({ standaloneCommandOmitted: 'secret-bearing' });
  expect(
    projectStandaloneCommand({
      command: 'record',
      session: 'safe',
      positionals: ['start'],
      flags: { out: 'inherited' },
    }).standaloneCommand,
  ).toBe('agent-device record start --session safe');
  const tracePath = ['cpu', 'profile', 'report', 'xctrace', '', '', 'private.trace'];
  expect(
    formatPerfRuntimeRequestArgs(parsePerfRuntimeRequest({ positionals: tracePath })),
  ).toBeUndefined();
  expect(
    projectStandaloneCommand({ command: 'perf', session: 'safe', positionals: tracePath }, null),
  ).toEqual({ standaloneCommandOmitted: 'not-cli-representable' });
  const privateContext = projectStandaloneCommand({
    ...base,
    flags: {
      platform: 'android',
      serial: 'device with space',
      daemonBaseUrl: 'https://secret.example/?token=canary',
      daemonAuthToken: 'token-canary',
      config: '/private/canary.json',
      out: 'inherited',
    } as CommandFlags,
  });
  expect(privateContext.standaloneCommand).toContain("--serial 'device with space'");
  expect(JSON.stringify(privateContext)).not.toMatch(/canary|secret/);
  const backend = projectStandaloneCommand({
    command: 'test',
    session: 'safe',
    positionals: ['flow.yaml'],
    flags: { replayBackend: 'maestro' },
  });
  expect(backend.standaloneCommand).toBe('agent-device test flow.yaml --maestro --session safe');
});
