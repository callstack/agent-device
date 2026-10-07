import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { commandDescriptors } from '@agent-device/command-registry/registry';
import type { CommandDescriptor } from '@agent-device/command-registry/types';
import { AppError, errorMessage } from '@agent-device/kernel/errors';

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
  /** Every request must be admitted under a lease of this backend, the one host-allocated backend. */
  requiredLeaseBackend?: 'macos-app';
}>;

const DESCRIPTORS = commandDescriptors as readonly CommandDescriptor[];

/**
 * Derived from the registry (catalog group plus platform execution). Internal daemon commands with
 * no platform execution — leases, `human_control`, session bookkeeping — are protocol plumbing that no
 * command rule decides. Every other command a request names is decided by command rules, including
 * a name the registry does not know, so an allow list fails closed.
 */
const PROTOCOL_COMMANDS: ReadonlySet<string> = new Set(
  DESCRIPTORS.filter(
    (descriptor) =>
      descriptor.catalog.group === 'internal' &&
      descriptor.daemon !== undefined &&
      descriptor.platformExecution.kind === 'none',
  ).map((descriptor) => descriptor.name),
);

/**
 * The names a policy may use: public commands, and internal commands with platform execution,
 * each by the public command it serves (`install_source` as `install-from-source`) or else by its
 * own name (`runtime`).
 */
const POLICY_COMMAND_NAMES: ReadonlyMap<string, string> = new Map(
  DESCRIPTORS.flatMap((descriptor) => {
    const { group, servesPublicCommand } = descriptor.catalog;
    if (group === 'public') return [[descriptor.name, descriptor.name] as const];
    if (group !== 'internal' || PROTOCOL_COMMANDS.has(descriptor.name)) return [];
    return [[descriptor.name, servesPublicCommand ?? descriptor.name] as const];
  }),
);
const POLICY_COMMAND_VOCABULARY: ReadonlySet<string> = new Set(POLICY_COMMAND_NAMES.values());
const LOCAL_CLI_COMMAND_NAMES: ReadonlySet<string> = new Set(
  DESCRIPTORS.filter((descriptor) => descriptor.catalog.group === 'local-cli').map(
    (descriptor) => descriptor.name,
  ),
);

/** The name command rules decide `command` by, or undefined for protocol plumbing. */
export function resolveDaemonPolicyCommandName(command: string): string | undefined {
  if (PROTOCOL_COMMANDS.has(command)) return undefined;
  return POLICY_COMMAND_NAMES.get(command) ?? command;
}

const POLICY_KEYS = new Set(['version', 'devices', 'commands', 'capabilities', 'leases']);

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
  const requiredLeaseBackend =
    root.leases === undefined ? undefined : parseLeases(root.leases, sourcePath);
  const canonical = JSON.stringify({
    devices: deviceIds ? [...deviceIds].sort() : null,
    commands: commands ? { mode: commands.mode, names: [...commands.names].sort() } : null,
    capabilities: [...deniedCapabilities].sort(),
    ...(requiredLeaseBackend ? { leases: { require: requiredLeaseBackend } } : {}),
  });
  return Object.freeze({
    sourcePath,
    digest: crypto.createHash('sha256').update(canonical).digest('hex'),
    deviceIds,
    commands,
    deniedCapabilities,
    ...(requiredLeaseBackend ? { requiredLeaseBackend } : {}),
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
    if (typeof name === 'string' && LOCAL_CLI_COMMAND_NAMES.has(name)) {
      throw invalidPolicy(
        sourcePath,
        `"${label}" names ${JSON.stringify(name)}, which runs in the client; name the daemon command it sends, such as "runtime"`,
      );
    }
    if (typeof name !== 'string' || !POLICY_COMMAND_VOCABULARY.has(name)) {
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

function parseLeases(value: unknown, sourcePath: string): 'macos-app' {
  const leases = readObject(value, 'leases', sourcePath);
  assertOnlyKeys(leases, ['require'], 'leases', sourcePath);
  if (leases.require !== 'macos-app') {
    throw invalidPolicy(sourcePath, '"leases.require" must be macos-app');
  }
  return leases.require;
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
