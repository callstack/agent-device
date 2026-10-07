import { HOST_PATH_INPUT_KEYS } from '../../daemon/host-path-inputs.ts';
import { isRemoteTempArtifactLocation } from '../../remote/daemon-artifacts.ts';

/** Typed refusals of the Host public route policy (ADR 0021 §5, §6, §10 item 6). */
export const HOST_REFUSAL_REASONS = {
  admin: 'host-admin-refused',
  hostPath: 'host-path-refused',
  componentDownload: 'host-component-download-refused',
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
 * Positional arguments that name a daemon-host file. The remote client rewrites screenshot and
 * recording outputs to daemon temp locations and uploads install packages, so anything else here
 * names the Host machine's disk.
 */
const HOST_PATH_POSITIONALS: Readonly<Record<string, (positionals: readonly string[]) => number>> =
  {
    screenshot: () => 0,
    record: (positionals) => (positionals[0]?.toLowerCase() === 'start' ? 1 : -1),
    install: (positionals) => (positionals.length === 1 ? 0 : 1),
    reinstall: (positionals) => (positionals.length === 1 ? 0 : 1),
  };

export function normalizeRpcMethod(method: string): string {
  return method.replace(/^agent-device\./, 'agent_device.');
}

export function findHostRpcRefusal(method: string, params: Params): HostRefusal | undefined {
  return (
    findAllocatorPolicyOverride(params) ??
    findAdminAllocation(method, params) ??
    findHostPathInput(params)
  );
}

/**
 * Drops every identity a client can claim in the body. The daemon pins the tenant to the Host
 * principal anyway; removing the claims keeps them out of logs and the auth hook context.
 */
export function stripClientIdentity(params: Params): Params {
  const { tenant: _tenant, tenantId: _tenantId, ...rest } = params;
  const meta = asRecord(rest.meta);
  const flags = asRecord(rest.flags);
  return {
    ...rest,
    ...(meta ? { meta: withoutKey(meta, 'tenantId') } : {}),
    ...(flags ? { flags: withoutKey(flags, 'tenant') } : {}),
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
  if (method !== 'agent_device.lease.allocate' || params.backend !== 'macos-app') return undefined;
  return {
    reason: HOST_REFUSAL_REASONS.admin,
    message: 'Host does not allocate macos-app leases; they are host-administered.',
    field: 'backend',
  };
}

function findHostPathInput(params: Params): HostRefusal | undefined {
  const meta = asRecord(params.meta);
  const uploaded = typeof meta?.uploadedArtifactId === 'string' && meta.uploadedArtifactId !== '';
  if (!uploaded && (isPathSource(params.source) || isPathSource(meta?.installSource))) {
    return hostPathRefusal('installSource');
  }
  const fields = { ...asRecord(params.input), ...asRecord(params.flags) };
  const field = HOST_PATH_INPUT_KEYS.find(
    (key) => key !== 'installSource' && namesHostPath(fields[key]),
  );
  if (field) return hostPathRefusal(field);
  return uploaded ? undefined : findHostPathPositional(params);
}

function findHostPathPositional(params: Params): HostRefusal | undefined {
  const command = typeof params.command === 'string' ? params.command : '';
  const positionals = Array.isArray(params.positionals) ? params.positionals.map(String) : [];
  const index = HOST_PATH_POSITIONALS[command]?.(positionals) ?? -1;
  const value = positionals[index];
  if (value === undefined || /^https?:\/\//i.test(value) || isRemoteTempArtifactLocation(value)) {
    return undefined;
  }
  return hostPathRefusal('positionals');
}

function namesHostPath(value: unknown): boolean {
  if (value === undefined || value === false) return false;
  return !(typeof value === 'string' && isRemoteTempArtifactLocation(value));
}

function isPathSource(source: unknown): boolean {
  return asRecord(source)?.kind === 'path';
}

function hostPathRefusal(field: string): HostRefusal {
  return {
    reason: HOST_REFUSAL_REASONS.hostPath,
    message: `Host does not accept ${field} naming a path on the Host machine.`,
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
