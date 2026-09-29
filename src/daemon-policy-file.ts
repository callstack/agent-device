import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PUBLIC_COMMANDS } from '@agent-device/command-registry/catalog';
import { AppError } from '@agent-device/kernel/errors';

/**
 * ADR 0029: the operator-owned rules one daemon enforces for every request it admits. This module
 * owns the policy file: loading, validation, and the digest. It lives at the process root because
 * the daemon client reads the same digest to refuse reusing a daemon with another policy;
 * enforcement is daemon-owned in `src/daemon/daemon-policy.ts`.
 */
export const DAEMON_POLICY_ENV = 'AGENT_DEVICE_DAEMON_POLICY';

const DAEMON_POLICY_CAPABILITIES = ['device-shutdown'] as const;
export type DaemonPolicyCapability = (typeof DAEMON_POLICY_CAPABILITIES)[number];

export type DaemonPolicy = Readonly<{
  sourcePath: string;
  digest: string;
  /** Device ids (UDID or serial) the daemon may bind. Absent when every device is allowed. */
  deviceIds?: ReadonlySet<string>;
  commands?: Readonly<{ mode: 'allow' | 'deny'; names: ReadonlySet<string> }>;
  deniedCapabilities: ReadonlySet<DaemonPolicyCapability>;
}>;

const PUBLIC_COMMAND_NAMES: ReadonlySet<string> = new Set(Object.values(PUBLIC_COMMANDS));
const POLICY_KEYS = new Set(['version', 'devices', 'commands', 'capabilities']);

export function loadDaemonPolicy(env: NodeJS.ProcessEnv = process.env): DaemonPolicy | undefined {
  const configured = env[DAEMON_POLICY_ENV]?.trim();
  if (!configured) return undefined;
  const sourcePath = path.resolve(configured);
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
  } catch (error) {
    throw invalidPolicy(sourcePath, `cannot read policy JSON: ${errorMessage(error)}`);
  }
  return parseDaemonPolicy(raw, sourcePath);
}

export function parseDaemonPolicy(raw: unknown, sourcePath: string): DaemonPolicy {
  const root = readObject(raw, 'policy', sourcePath);
  for (const key of Object.keys(root)) {
    if (!POLICY_KEYS.has(key)) throw invalidPolicy(sourcePath, `unknown key "${key}"`);
  }
  if (root.version !== 1) throw invalidPolicy(sourcePath, '"version" must be 1');
  const deviceIds = root.devices === undefined ? undefined : parseDevices(root.devices, sourcePath);
  const commands =
    root.commands === undefined ? undefined : parseCommands(root.commands, sourcePath);
  const deniedCapabilities =
    root.capabilities === undefined
      ? new Set<DaemonPolicyCapability>()
      : parseCapabilities(root.capabilities, sourcePath);
  const canonical = JSON.stringify({
    devices: deviceIds ? [...deviceIds].sort() : null,
    commands: commands ? { mode: commands.mode, names: [...commands.names].sort() } : null,
    capabilities: [...deniedCapabilities].sort(),
  });
  return Object.freeze({
    sourcePath,
    digest: crypto.createHash('sha256').update(canonical).digest('hex'),
    deviceIds,
    commands,
    deniedCapabilities,
  });
}

function parseDevices(value: unknown, sourcePath: string): ReadonlySet<string> {
  const devices = readObject(value, 'devices', sourcePath);
  assertOnlyKeys(devices, ['allow'], 'devices', sourcePath);
  const allow = readArray(devices.allow, 'devices.allow', sourcePath);
  if (allow.length === 0) throw invalidPolicy(sourcePath, '"devices.allow" must not be empty');
  return new Set(
    allow.map((entry, index) => {
      const label = `devices.allow[${index}]`;
      const selector = readObject(entry, label, sourcePath);
      assertOnlyKeys(selector, ['udid', 'serial'], label, sourcePath);
      const ids = [selector.udid, selector.serial].filter((id) => id !== undefined);
      if (ids.length !== 1 || typeof ids[0] !== 'string' || !ids[0].trim()) {
        throw invalidPolicy(sourcePath, `"${label}" must name exactly one "udid" or "serial"`);
      }
      return ids[0].trim();
    }),
  );
}

function parseCommands(value: unknown, sourcePath: string): NonNullable<DaemonPolicy['commands']> {
  const commands = readObject(value, 'commands', sourcePath);
  assertOnlyKeys(commands, ['allow', 'deny'], 'commands', sourcePath);
  if ((commands.allow === undefined) === (commands.deny === undefined)) {
    throw invalidPolicy(sourcePath, '"commands" must set exactly one of "allow" or "deny"');
  }
  const mode = commands.allow === undefined ? 'deny' : 'allow';
  const label = `commands.${mode}`;
  const names = readArray(commands[mode], label, sourcePath).map((name) => {
    if (typeof name !== 'string' || !PUBLIC_COMMAND_NAMES.has(name)) {
      throw invalidPolicy(sourcePath, `"${label}" names unknown command ${JSON.stringify(name)}`);
    }
    return name;
  });
  return Object.freeze({ mode, names: new Set(names) });
}

function parseCapabilities(value: unknown, sourcePath: string): Set<DaemonPolicyCapability> {
  const capabilities = readObject(value, 'capabilities', sourcePath);
  assertOnlyKeys(capabilities, ['deny'], 'capabilities', sourcePath);
  const known: readonly string[] = DAEMON_POLICY_CAPABILITIES;
  return new Set(
    readArray(capabilities.deny, 'capabilities.deny', sourcePath).map((capability) => {
      if (typeof capability !== 'string' || !known.includes(capability)) {
        throw invalidPolicy(
          sourcePath,
          `"capabilities.deny" names unknown capability ${JSON.stringify(capability)}`,
        );
      }
      return capability as DaemonPolicyCapability;
    }),
  );
}

function readObject(value: unknown, label: string, sourcePath: string): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw invalidPolicy(sourcePath, `"${label}" must be an object`);
}

function readArray(value: unknown, label: string, sourcePath: string): unknown[] {
  if (Array.isArray(value)) return value;
  throw invalidPolicy(sourcePath, `"${label}" must be an array`);
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
  sourcePath: string,
): void {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw invalidPolicy(sourcePath, `unknown key "${label}.${key}"`);
  }
}

function invalidPolicy(sourcePath: string, problem: string): AppError {
  return new AppError('INVALID_ARGS', `Invalid daemon policy ${sourcePath}: ${problem}`, {
    policyPath: sourcePath,
    hint: `Fix the file named by ${DAEMON_POLICY_ENV}, then start the daemon again.`,
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
