// Which RPC methods the daemon answers, and how each method's params become the
// DaemonRequest the router dispatches. Malformed wire input is rejected here as
// INVALID_ARGS before the request reaches a handler.
import type { IncomingHttpHeaders } from 'node:http';
import { AppError } from '@agent-device/kernel/errors';
import type {
  CommandRpcParams,
  DaemonInstallSource,
  LeaseBackend,
} from '@agent-device/kernel/contracts';
import { commandRpcParamsSchema } from '@agent-device/kernel/contracts';
import { readLeaseAllocateProviderFlags } from '@agent-device/contracts/lease-scope';
import type { DaemonRequest } from '../daemon-request.ts';
import { resolveToken } from './http-authorization.ts';

type HttpInstallSource = Exclude<DaemonInstallSource, { kind: 'path' }>;

const COMMAND_RPC_METHODS = new Set(['agent_device.command', 'agent-device.command']);
const INSTALL_FROM_SOURCE_RPC_METHODS = new Set([
  'agent_device.install_from_source',
  'agent-device.install_from_source',
]);
const RELEASE_MATERIALIZED_PATHS_RPC_METHODS = new Set([
  'agent_device.release_materialized_paths',
  'agent-device.release_materialized_paths',
]);
const LEASE_RPC_METHOD_TO_COMMAND: Record<
  string,
  'lease_allocate' | 'lease_heartbeat' | 'lease_release'
> = {
  'agent_device.lease.allocate': 'lease_allocate',
  'agent-device.lease.allocate': 'lease_allocate',
  'agent_device.lease.heartbeat': 'lease_heartbeat',
  'agent-device.lease.heartbeat': 'lease_heartbeat',
  'agent_device.lease.release': 'lease_release',
  'agent-device.lease.release': 'lease_release',
};
const SUPPORTED_RPC_METHODS = new Set([
  ...COMMAND_RPC_METHODS,
  ...INSTALL_FROM_SOURCE_RPC_METHODS,
  ...RELEASE_MATERIALIZED_PATHS_RPC_METHODS,
  ...Object.keys(LEASE_RPC_METHOD_TO_COMMAND),
]);

function toDaemonRequest(params: CommandRpcParams, headers: IncomingHttpHeaders): DaemonRequest {
  return {
    token: resolveToken(params as Record<string, unknown>, headers),
    session: params.session ?? 'default',
    command: params.command ?? '',
    positionals: params.positionals ?? [],
    input: params.input,
    // flags/runtime/meta are validated as objects at the boundary; their full shape is
    // validated in the session open handler downstream.
    flags: params.flags as DaemonRequest['flags'],
    runtime: params.runtime,
    meta: params.meta as DaemonRequest['meta'],
  };
}

function readStringParam(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  return typeof value === 'string' ? value : undefined;
}

function readIntParam(params: Record<string, unknown>, key: string): number | undefined {
  const value = params[key];
  return Number.isInteger(value) ? Number(value) : undefined;
}

function readBooleanParam(params: Record<string, unknown>, key: string): boolean | undefined {
  const value = params[key];
  return typeof value === 'boolean' ? value : undefined;
}

function readRequiredGitHubArtifactText(
  record: Record<string, unknown>,
  key: 'owner' | 'repo' | 'artifactName',
): string {
  const value = typeof record[key] === 'string' ? record[key].trim() : '';
  if (!value) {
    throw new AppError(
      'INVALID_ARGS',
      `Invalid params: source.${key} is required for github-actions-artifact sources`,
    );
  }
  return value;
}

function readGitHubArtifactInteger(record: Record<string, unknown>, key: 'artifactId' | 'runId') {
  const value = record[key];
  const parsed =
    typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  if (!Number.isInteger(parsed)) {
    throw new AppError('INVALID_ARGS', `Invalid params: source.${key} must be an integer`);
  }
  return parsed;
}

function parseGitHubActionsArtifactSource(record: Record<string, unknown>): HttpInstallSource {
  const owner = readRequiredGitHubArtifactText(record, 'owner');
  const repo = readRequiredGitHubArtifactText(record, 'repo');
  const hasArtifactId = record.artifactId !== undefined;
  const hasRunId = record.runId !== undefined;
  const hasArtifactName = record.artifactName !== undefined;
  if (hasArtifactId && (hasRunId || hasArtifactName)) {
    throw new AppError(
      'INVALID_ARGS',
      'Invalid params: source must specify either artifactId or artifactName, not both',
    );
  }
  if (!hasArtifactId && hasRunId && !hasArtifactName) {
    throw new AppError(
      'INVALID_ARGS',
      'Invalid params: source.artifactName is required when source.runId is specified',
    );
  }
  if (!hasArtifactId && !hasArtifactName) {
    throw new AppError(
      'INVALID_ARGS',
      'Invalid params: source must specify artifactId or artifactName',
    );
  }
  if (hasArtifactId) {
    return {
      kind: 'github-actions-artifact',
      owner,
      repo,
      artifactId: readGitHubArtifactInteger(record, 'artifactId'),
    };
  }
  let runId: number | undefined;
  if (hasRunId) {
    runId = readGitHubArtifactInteger(record, 'runId');
  }
  return {
    kind: 'github-actions-artifact',
    owner,
    repo,
    ...(hasRunId ? { runId } : {}),
    artifactName: readRequiredGitHubArtifactText(record, 'artifactName'),
  };
}

function toLeaseDaemonRequest(
  command: 'lease_allocate' | 'lease_heartbeat' | 'lease_release',
  params: Record<string, unknown>,
  headers: IncomingHttpHeaders,
): DaemonRequest {
  return {
    token: resolveToken(params, headers),
    session: readStringParam(params, 'session') ?? 'default',
    command,
    positionals: [],
    flags: command === 'lease_allocate' ? readLeaseAllocateProviderFlags(params) : undefined,
    meta: {
      tenantId: readStringParam(params, 'tenantId') ?? readStringParam(params, 'tenant'),
      runId: readStringParam(params, 'runId'),
      leaseId: readStringParam(params, 'leaseId'),
      leaseTtlMs: readIntParam(params, 'ttlMs'),
      leaseRetainOnClose: readBooleanParam(params, 'retainOnClose'),
      leaseBackend: readStringParam(params, 'backend') as LeaseBackend | undefined,
      leaseProvider:
        readStringParam(params, 'leaseProvider') ?? readStringParam(params, 'provider'),
      deviceKey: readStringParam(params, 'deviceKey'),
      clientId: readStringParam(params, 'clientId'),
      providerCredentialFingerprint:
        command === 'lease_allocate'
          ? readStringParam(params, 'providerCredentialFingerprint')
          : undefined,
    },
  };
}

function parseInstallSource(params: Record<string, unknown>): HttpInstallSource {
  const source = params.source;
  if (!source || typeof source !== 'object') {
    throw new AppError('INVALID_ARGS', 'Invalid params: source is required');
  }
  const record = source as Record<string, unknown>;
  if (record.kind === 'url') {
    const url = typeof record.url === 'string' ? record.url.trim() : '';
    if (!url) {
      throw new AppError('INVALID_ARGS', 'Invalid params: source.url is required for url sources');
    }
    const rawHeaders = record.headers;
    const headers: Record<string, string> = {};
    if (rawHeaders !== undefined) {
      if (!rawHeaders || typeof rawHeaders !== 'object' || Array.isArray(rawHeaders)) {
        throw new AppError('INVALID_ARGS', 'Invalid params: source.headers must be a string map');
      }
      for (const [key, value] of Object.entries(rawHeaders as Record<string, unknown>)) {
        if (typeof value !== 'string') {
          throw new AppError(
            'INVALID_ARGS',
            'Invalid params: source.headers values must be strings',
          );
        }
        headers[key] = value;
      }
    }
    return Object.keys(headers).length > 0 ? { kind: 'url', url, headers } : { kind: 'url', url };
  }
  if (record.kind === 'path') {
    throw new AppError(
      'INVALID_ARGS',
      'Invalid params: source.kind "path" names a file on the daemon host and is not accepted over HTTP',
      { hint: 'Use a "url" or "github-actions-artifact" source.' },
    );
  }
  if (record.kind === 'github-actions-artifact') {
    return parseGitHubActionsArtifactSource(record);
  }
  throw new AppError(
    'INVALID_ARGS',
    'Invalid params: source.kind must be "url" or "github-actions-artifact"',
  );
}

function toInstallFromSourceDaemonRequest(
  params: Record<string, unknown>,
  headers: IncomingHttpHeaders,
): DaemonRequest {
  const platform = readStringParam(params, 'platform');
  if (platform !== 'ios' && platform !== 'android') {
    throw new AppError('INVALID_ARGS', 'Invalid params: platform must be "ios" or "android"');
  }
  return {
    token: resolveToken(params, headers),
    session: readStringParam(params, 'session') ?? 'default',
    command: 'install_source',
    positionals: [],
    flags: { platform },
    meta: {
      requestId: readStringParam(params, 'requestId'),
      installSource: parseInstallSource(params),
      retainMaterializedPaths: readBooleanParam(params, 'retainPaths'),
      materializedPathRetentionMs: readIntParam(params, 'retentionMs'),
    },
  };
}

function toReleaseMaterializedPathsDaemonRequest(
  params: Record<string, unknown>,
  headers: IncomingHttpHeaders,
): DaemonRequest {
  const materializationId = readStringParam(params, 'materializationId')?.trim();
  if (!materializationId) {
    throw new AppError('INVALID_ARGS', 'Invalid params: materializationId is required');
  }
  return {
    token: resolveToken(params, headers),
    session: readStringParam(params, 'session') ?? 'default',
    command: 'release_materialized_paths',
    positionals: [],
    meta: {
      requestId: readStringParam(params, 'requestId'),
      materializationId,
    },
  };
}

// The runtime schema reports failures with an internal JSON-path prefix
// (e.g. `$.positionals: Expected an array`). Strip the `$` sigil so the wire message
// stays user-facing without leaking the schema's internal path representation.
function cleanSchemaParseMessage(message: string): string {
  const separator = message.indexOf(': ');
  if (separator === -1 || !message.startsWith('$')) return message;
  const field = message.slice(0, separator).replace(/^\$\.?/, '');
  const detail = message.slice(separator + 2);
  return field ? `${field}: ${detail}` : detail;
}

// Validate the command params at the boundary so malformed client input is rejected as
// INVALID_ARGS (-> JSON-RPC -32602 / HTTP 400) instead of leaking as an internal 500.
function parseCommandRpcParams(params: Record<string, unknown>): CommandRpcParams {
  try {
    return commandRpcParamsSchema.parse(params);
  } catch (error) {
    const detail =
      error instanceof Error ? cleanSchemaParseMessage(error.message) : 'invalid command params';
    throw new AppError('INVALID_ARGS', `Invalid params: ${detail}`);
  }
}

function methodToDaemonRequest(
  method: string,
  params: Record<string, unknown>,
  headers: IncomingHttpHeaders,
): DaemonRequest {
  if (COMMAND_RPC_METHODS.has(method)) {
    return toDaemonRequest(parseCommandRpcParams(params), headers);
  }
  if (INSTALL_FROM_SOURCE_RPC_METHODS.has(method)) {
    return toInstallFromSourceDaemonRequest(params, headers);
  }
  if (RELEASE_MATERIALIZED_PATHS_RPC_METHODS.has(method)) {
    return toReleaseMaterializedPathsDaemonRequest(params, headers);
  }
  const leaseCommand = LEASE_RPC_METHOD_TO_COMMAND[method];
  if (leaseCommand) {
    return toLeaseDaemonRequest(leaseCommand, params, headers);
  }
  throw new AppError('INVALID_ARGS', `Method not found: ${method}`);
}

function isCommandRpcMethod(method: string): boolean {
  return COMMAND_RPC_METHODS.has(method);
}

export { SUPPORTED_RPC_METHODS, isCommandRpcMethod, methodToDaemonRequest };
