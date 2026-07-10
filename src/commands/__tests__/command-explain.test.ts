import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { commandDescriptors } from '../../core/command-descriptor/registry.ts';
import { getDaemonRouteOwnerFiles } from '../../daemon/request-handler-chain.ts';
import {
  explainCommand as explainCommandFromMetadata,
  formatCommandExplanation,
} from '../command-explain.ts';

const repoRoot = path.resolve(import.meta.dirname, '../../..');
const fileExists = (file: string) => fs.existsSync(path.join(repoRoot, file));
const daemonRouteOwnerFiles = getDaemonRouteOwnerFiles();
const explainCommand = (
  query: string,
  options: Omit<Parameters<typeof explainCommandFromMetadata>[1], 'daemonRouteOwnerFiles'> = {},
) =>
  explainCommandFromMetadata(query, {
    ...options,
    daemonRouteOwnerFiles,
  });

function runExplainCli(args: string[]): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(
      process.execPath,
      ['--experimental-strip-types', 'scripts/explain-command.ts', ...args],
      { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return {
      status: failure.status ?? 1,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? '',
    };
  }
}

describe('explainCommand', () => {
  test('resolves every descriptor name and catalog key', () => {
    for (const descriptor of commandDescriptors) {
      expect(explainCommand(descriptor.name, { fileExists })).toMatchObject({
        found: true,
        explanation: { command: descriptor.name },
      });
      if ('key' in descriptor.catalog && descriptor.catalog.key) {
        expect(explainCommand(descriptor.catalog.key, { fileExists })).toMatchObject({
          found: true,
          explanation: { command: descriptor.name },
        });
      }
    }
  });

  test('projects click policy, flags, and validated ownership files', () => {
    const result = explainCommand('click', { fileExists });
    expect(result).toMatchObject({
      found: true,
      explanation: {
        command: 'click',
        family: 'interaction',
        daemon: { route: 'interaction' },
        exposure: {
          batchable: true,
          mcp: true,
          dispatch: false,
          postActionObservation: 'settle-and-verify',
        },
        cli: { usage: 'click <x y|@ref|selector>' },
      },
    });
    if (!result.found) return;
    expect(result.explanation.cli?.commandFlags.map((flag) => flag.key)).toContain('settle');
    expect(result.explanation.files).toContain('src/commands/interaction/index.ts');
    expect(result.explanation.files).toContain('src/daemon/handlers/interaction.ts');
    expect(result.explanation.files.every(fileExists)).toBe(true);
  });

  test('degrades gracefully for schema-only local commands', () => {
    expect(explainCommand('web', { fileExists })).toMatchObject({
      found: true,
      explanation: {
        command: 'web',
        catalog: { group: 'local-cli' },
        cli: { usage: 'web setup | web doctor' },
        files: expect.arrayContaining([
          'src/core/command-descriptor/registry.ts',
          'src/utils/cli-command-overrides.ts',
          'src/cli/commands/web.ts',
        ]),
      },
    });
  });
});

describe('formatCommandExplanation', () => {
  test('suggests close descriptor names for unknown queries', () => {
    expect(explainCommand('longpres')).toEqual({
      found: false,
      query: 'longpres',
      suggestions: expect.arrayContaining(['longpress']),
    });
  });

  test('renders concise text and serializable JSON', () => {
    const result = explainCommand('longPress', { fileExists });
    expect(result.found).toBe(true);
    if (!result.found) return;
    const text = formatCommandExplanation(result.explanation);
    expect(text).toContain('longpress [public]');
    expect(text).toContain('catalog: longPress (alias: long-press)');
    expect(JSON.parse(JSON.stringify(result.explanation))).toMatchObject({
      command: 'longpress',
      catalog: { key: 'longPress' },
      aliases: [{ alias: 'long-press' }],
    });
  });
});

describe('explainCommand table-driven coverage', () => {
  test.each([
    ['launch', 'open', [{ alias: 'launch' }, { alias: 'relaunch', impliedFlags: ['relaunch'] }]],
    ['long-press', 'longpress', [{ alias: 'long-press' }]],
    ['metrics', 'perf', [{ alias: 'metrics' }]],
    ['TAP', 'press', [{ alias: 'tap' }]],
  ])('resolves CLI alias %s to %s', (query, command, aliases) => {
    const result = explainCommand(query as string, { fileExists });
    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(result.explanation.command).toBe(command);
    expect(result.explanation.aliases).toEqual(aliases);
  });

  test('synthesizes usage with positionals and flags when no usageOverride', () => {
    const result = explainCommand('type', { fileExists });
    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(result.explanation.cli?.usage).toBe('type <text> [--delay-ms <ms>]');
  });

  test.each([
    ['press', ['src/commands/interaction/index.ts', 'src/daemon/handlers/interaction.ts']],
    ['apps', ['src/commands/management/app.ts']],
    ['screenshot', ['src/commands/capture/screenshot.ts', 'src/core/dispatch.ts']],
    ['react-native', ['src/daemon/handlers/react-native.ts']],
    ['record', ['src/daemon/handlers/record-trace.ts']],
    ['trace', ['src/daemon/handlers/record-trace.ts']],
    ['back', ['src/daemon/request-generic-dispatch.ts']],
    ['home', ['src/daemon/request-generic-dispatch.ts']],
  ])('derives owner files for %s (split family / route variant / dispatch)', (command, owners) => {
    const result = explainCommand(command as string, { fileExists });
    expect(result.found).toBe(true);
    if (!result.found) return;
    for (const owner of owners as string[]) {
      expect(result.explanation.files).toContain(owner);
    }
    expect(result.explanation.files.every(fileExists)).toBe(true);
  });

  test('every command resolves to existing owner files (no silent drops)', () => {
    for (const descriptor of commandDescriptors) {
      const result = explainCommand(descriptor.name, { fileExists });
      expect(result.found).toBe(true);
      if (!result.found) continue;
      for (const ownerFile of descriptor.ownerFiles) {
        expect(result.explanation.files).toContain(ownerFile);
      }
      for (const file of result.explanation.files) {
        expect(fileExists(file), `${descriptor.name} owner missing: ${file}`).toBe(true);
      }
    }
  });

  test('every daemon explanation uses its production handler module owner', () => {
    for (const descriptor of commandDescriptors) {
      if (!('daemon' in descriptor) || !descriptor.daemon) continue;
      const result = explainCommand(descriptor.name, { fileExists });
      expect(result.found).toBe(true);
      if (!result.found) continue;
      const ownerFile = daemonRouteOwnerFiles[descriptor.daemon.route];
      expect(result.explanation.files).toContain(ownerFile);
      expect(fileExists(ownerFile), `${descriptor.daemon.route} route owner missing`).toBe(true);
    }
  });

  test('structured explanation is JSON-serializable and round-trips', () => {
    const result = explainCommand('open', { fileExists });
    expect(result.found).toBe(true);
    if (!result.found) return;
    const round = JSON.parse(JSON.stringify(result.explanation));
    expect(round).toEqual(result.explanation);
  });
});

describe('explain:command CLI', () => {
  test('prints the formatted explanation to stdout and exits 0', () => {
    const { status, stdout, stderr } = runExplainCli(['open']);
    expect(status).toBe(0);
    expect(stderr).toBe('');
    expect(stdout).toContain('open [public]');
    expect(stdout).toContain('catalog: open (alias: launch, relaunch (implies --relaunch))');
  });

  test('keeps default text compact and exposes exhaustive flags only on demand', () => {
    const compact = runExplainCli(['apps']);
    expect(compact.status).toBe(0);
    expect(compact.stdout).toContain('usage: apps [--all]');
    expect(compact.stdout).toContain('flags: --all');
    expect(compact.stdout).not.toContain('supported:');
    expect(compact.stdout).not.toContain('global:');

    const full = runExplainCli(['apps', '--full']);
    expect(full.status).toBe(0);
    expect(full.stdout).toContain('supported:');
    expect(full.stdout).toContain('global:');
  });

  test('emits structured JSON with --json and exits 0', () => {
    const { status, stdout } = runExplainCli(['apps', '--json']);
    expect(status).toBe(0);
    const data = JSON.parse(stdout);
    expect(data).toMatchObject({ command: 'apps', cli: { commandFlags: [{ key: 'appsFilter' }] } });
    expect(data.cli.supportedFlags.length).toBeGreaterThan(data.cli.commandFlags.length);
    expect(data.cli.globalFlags.length).toBeGreaterThan(0);
  });

  test('reports unknown commands on stderr and exits 1', () => {
    const { status, stdout, stderr } = runExplainCli(['definitely-not-a-command']);
    expect(status).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toContain('Unknown command "definitely-not-a-command"');
  });
});
