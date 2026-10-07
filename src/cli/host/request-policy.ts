import path from 'node:path';
import { normalizeBatchCommandName } from '@agent-device/command-registry/batch-policy';
import { getCommandSchema } from '../../commands/schema/command-schema.ts';
import { HOST_PATH_INPUT_KEYS } from '../../daemon/host-path-inputs.ts';
import { normalizeLeaseBackend } from '../../daemon/lease-registry-scope.ts';
import { isRemoteTempArtifactPath } from '../../remote/daemon-artifacts.ts';

/** Typed refusals of the Host public route policy (ADR 0021 §5, §6, §10 item 6). */
const HOST_REFUSAL_REASONS = {
  admin: 'host-admin-refused',
  hostPath: 'host-path-refused',
  componentDownload: 'host-component-download-refused',
  script: 'host-script-refused',
} as const;

export type HostRefusal = Readonly<{
  reason: (typeof HOST_REFUSAL_REASONS)[keyof typeof HOST_REFUSAL_REASONS];
  message: string;
  field?: string;
}>;

type Params = Record<string, unknown>;

/** Allocator policy a public caller may not override; Simlock reads it as "download components". */
const ALLOCATOR_POLICY_KEYS = ['allowDownload'] as const;

/**
 * Commands that run nested actions from a script the Host cannot inspect before the daemon
 * dispatches them, so each action would escape this policy.
 */
const SCRIPT_COMMANDS: ReadonlySet<string> = new Set(['replay', 'test']);

/** The daemon reads an upload id only on these; anywhere else it would just switch the check off. */
const UPLOAD_COMMANDS: ReadonlySet<string> = new Set(['install', 'reinstall', 'install_source']);

export function normalizeRpcMethod(method: string): string {
  return method.replace(/^agent-device\./, 'agent_device.');
}

export function findHostRpcRefusal(method: string, params: Params): HostRefusal | undefined {
  return (
    findAllocatorPolicyOverride(params) ??
    findAdminAllocation(method, params) ??
    findHostPathInSource(params) ??
    findRequestRefusal(params)
  );
}

/**
 * Drops every identity a client can claim in the body, batch steps included. The daemon pins
 * the tenant to the Host principal anyway; removing the claims keeps them out of the request.
 */
export function stripClientIdentity(params: Params): Params {
  const { tenant: _tenant, tenantId: _tenantId, ...rest } = params;
  const meta = asRecord(rest.meta);
  const flags = asRecord(rest.flags);
  return {
    ...rest,
    ...(meta ? { meta: withoutKey(meta, 'tenantId') } : {}),
    ...(flags ? { flags: stripStepIdentity(flags) } : {}),
  };
}

function stripStepIdentity(flags: Params): Params {
  const stripped = withoutKey(flags, 'tenant');
  if (!Array.isArray(stripped.batchSteps)) return stripped;
  return {
    ...stripped,
    batchSteps: stripped.batchSteps.map((step) => {
      const record = asRecord(step);
      const stepFlags = asRecord(record?.flags);
      return record && stepFlags ? { ...record, flags: stripStepIdentity(stepFlags) } : step;
    }),
  };
}

function findAllocatorPolicyOverride(params: Params): HostRefusal | undefined {
  const scopes = [params, asRecord(params.flags), asRecord(params.input), asRecord(params.shape)];
  for (const key of ALLOCATOR_POLICY_KEYS) {
    if (scopes.some((scope) => scope?.[key] !== undefined)) {
      return {
        reason: HOST_REFUSAL_REASONS.componentDownload,
        message: `Host does not accept ${key}; components are installed by the operator.`,
        field: key,
      };
    }
  }
  return undefined;
}

function findAdminAllocation(method: string, params: Params): HostRefusal | undefined {
  if (method !== 'agent_device.lease.allocate' || !isMacOsAppBackend(params.backend)) {
    return undefined;
  }
  return {
    reason: HOST_REFUSAL_REASONS.admin,
    message: 'Host does not allocate macos-app leases; they are host-administered.',
    field: 'backend',
  };
}

/** Reads the backend the way the daemon does; a value it would refuse is not macos-app. */
function isMacOsAppBackend(raw: unknown): boolean {
  if (typeof raw !== 'string') return false;
  try {
    return normalizeLeaseBackend(raw) === 'macos-app';
  } catch {
    return false;
  }
}

function findHostPathInSource(params: Params): HostRefusal | undefined {
  const meta = asRecord(params.meta);
  if (isPathSource(params.source)) return hostPathRefusal('source');
  if (isPathSource(meta?.installSource) && !hasUpload(meta))
    return hostPathRefusal('installSource');
  return undefined;
}

/** Checks one command request and, for a batch, every step the daemon will admit after it. */
function findRequestRefusal(request: Params): HostRefusal | undefined {
  const command = normalizeBatchCommandName(request.command);
  if (SCRIPT_COMMANDS.has(command)) {
    return {
      reason: HOST_REFUSAL_REASONS.script,
      message: `Host does not run ${command}; send the commands one by one or as a batch.`,
      field: 'command',
    };
  }
  const flags = asRecord(request.flags);
  const refusal =
    findHostPathInput(command, { ...asRecord(request.input), ...flags }) ??
    findHostPathPositional(command, request);
  if (refusal) return refusal;
  for (const step of Array.isArray(flags?.batchSteps) ? flags.batchSteps : []) {
    const stepRefusal = findRequestRefusal(asRecord(step) ?? {});
    if (stepRefusal) return stepRefusal;
  }
  return undefined;
}

function findHostPathInput(command: string, fields: Params): HostRefusal | undefined {
  const field = HOST_PATH_INPUT_KEYS.find(
    (key) =>
      key !== 'installSource' &&
      fields[key] !== undefined &&
      fields[key] !== false &&
      !isClientArtifactLocation(command, key, fields[key]),
  );
  return field ? hostPathRefusal(field) : undefined;
}

/** Positionals the command schema names as paths, such as `path?` or `appOrPath`. */
function findHostPathPositional(command: string, request: Params): HostRefusal | undefined {
  const positionals = Array.isArray(request.positionals) ? request.positionals.map(String) : [];
  const names = getCommandSchema(command)?.positionalArgs ?? [];
  const uploaded = UPLOAD_COMMANDS.has(command) && hasUpload(asRecord(request.meta));
  const refused = names.some(
    (name, index) => !uploaded && namesHostPathPositional(command, name, positionals, index),
  );
  return refused ? hostPathRefusal('positionals') : undefined;
}

function namesHostPathPositional(
  command: string,
  name: string,
  positionals: readonly string[],
  index: number,
): boolean {
  const value = positionals[index];
  if (value === undefined) return false;
  if (!namesPathPositional(name, value, index === positionals.length - 1)) return false;
  return !isClientArtifactLocation(command, `positional:${index}`, value);
}

/**
 * `path` always names a path. An `appOrPath`-style positional names one when it is the last
 * positional given, which is how `install <path>` and `install <app> <path>` read it, and
 * `payloadOrJson` names one unless the value is inline JSON.
 */
function namesPathPositional(name: string, value: string, isLast: boolean): boolean {
  const bare = name.replace(/\?$/, '');
  if (/^payload/i.test(bare)) return !/^\s*[[{]/.test(value);
  if (bare === 'path' || /^pathOr/.test(bare)) return true;
  return /Path$/.test(bare) && isLast;
}

/**
 * The daemon temp locations the remote client itself writes outputs to and downloads afterwards
 * (`src/remote/daemon-artifacts.ts`). Any other value names the Host machine's disk.
 */
function isClientArtifactLocation(command: string, field: string, value: unknown): boolean {
  if (typeof value !== 'string') return false;
  if (command === 'screenshot' && (field === 'out' || field === 'positional:0')) {
    return isRemoteTempArtifactPath(value, 'screenshot', '.png');
  }
  if (command === 'record' && field === 'positional:1') {
    return isRemoteTempArtifactPath(value, 'recording', path.posix.extname(value));
  }
  return false;
}

function hasUpload(meta: Params | undefined): boolean {
  return typeof meta?.uploadedArtifactId === 'string' && meta.uploadedArtifactId.trim() !== '';
}

function isPathSource(source: unknown): boolean {
  return asRecord(source)?.kind === 'path';
}

function hostPathRefusal(field: string): HostRefusal {
  return {
    reason: HOST_REFUSAL_REASONS.hostPath,
    message: `Host does not accept ${field}, which names or returns a path on the Host machine.`,
    field,
  };
}

function asRecord(value: unknown): Params | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Params)
    : undefined;
}

function withoutKey(record: Params, key: string): Params {
  const { [key]: _removed, ...rest } = record;
  return rest;
}
