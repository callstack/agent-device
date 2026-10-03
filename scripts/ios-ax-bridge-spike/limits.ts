import type { RawAcquiredNode, RawAcquisition, ResourceLimits, SpikeRect } from './types.ts';

export const DEFAULT_SPIKE_LIMITS: ResourceLimits = Object.freeze({
  maxRequestBytes: 64 * 1024,
  maxResponseBytes: 4 * 1024 * 1024,
  maxNodes: 1500,
  maxTraversalDepth: 64,
  maxCpuMs: 2_000,
  maxMemoryBytes: 256 * 1024 * 1024,
  maxDurationMs: 5_000,
});

const NODE_KEYS = new Set([
  'id',
  'type',
  'parentId',
  'role',
  'subrole',
  'label',
  'value',
  'identifier',
  'frame',
  'enabled',
  'selected',
  'focused',
]);

export type TreeValidation =
  | Readonly<{ ok: true; acquisition: RawAcquisition; maxTraversalDepth: number }>
  | Readonly<{ ok: false; code: string }>;

export function encodeFrame(value: unknown): { bytes: number; line: string } {
  const line = `${JSON.stringify(value)}\n`;
  return { bytes: Buffer.byteLength(line), line };
}

export function validateRawAcquisition(value: unknown, limits: ResourceLimits): TreeValidation {
  const record = readAcquisitionRecord(value);
  if (!record.ok) return record;
  const envelope = validateAcquisitionEnvelope(record.value);
  if (!envelope.ok) return envelope;
  if (record.value.nodes.length > limits.maxNodes)
    return { ok: false, code: 'node-limit-exceeded' };
  const nodes = validateNodes(record.value.nodes);
  if (!nodes.ok) return nodes;
  const maxTraversalDepth = treeDepth(nodes.nodes);
  if (maxTraversalDepth > limits.maxTraversalDepth) {
    return { ok: false, code: 'traversal-depth-exceeded' };
  }
  return {
    ok: true,
    acquisition: record.value as unknown as RawAcquisition,
    maxTraversalDepth,
  };
}

function readAcquisitionRecord(
  value: unknown,
):
  | { ok: true; value: Record<string, unknown> & { nodes: unknown[] } }
  | { ok: false; code: string } {
  if (!isRecord(value)) return { ok: false, code: 'acquisition-not-object' };
  if (typeof value.targetId !== 'string' || value.targetId.length === 0) {
    return { ok: false, code: 'target-id-missing' };
  }
  if (value.targetGeneration !== null && typeof value.targetGeneration !== 'string') {
    return { ok: false, code: 'target-generation-invalid' };
  }
  if (!Array.isArray(value.nodes)) return { ok: false, code: 'nodes-not-array' };
  return { ok: true, value: value as Record<string, unknown> & { nodes: unknown[] } };
}

function validateAcquisitionEnvelope(
  value: Record<string, unknown>,
): { ok: true } | { ok: false; code: string } {
  if (typeof value.truncated !== 'boolean') return { ok: false, code: 'truncated-invalid' };
  if (!validateViewport(value.viewport)) return { ok: false, code: 'viewport-invalid' };
  if (!validateResidue(value.residue)) return { ok: false, code: 'residue-invalid' };
  return { ok: true };
}

function validateNodes(
  rawNodes: readonly unknown[],
): { ok: true; nodes: RawAcquiredNode[] } | { ok: false; code: string } {
  const nodes: RawAcquiredNode[] = [];
  const ids = new Set<string>();
  for (const rawNode of rawNodes) {
    const node = validateNode(rawNode);
    if (!node.ok) return node;
    if (ids.has(node.node.id)) return { ok: false, code: 'duplicate-node-id' };
    ids.add(node.node.id);
    nodes.push(node.node);
  }
  return validateParents(nodes, ids);
}

function validateParents(
  nodes: readonly RawAcquiredNode[],
  ids: ReadonlySet<string>,
): { ok: true; nodes: RawAcquiredNode[] } | { ok: false; code: string } {
  for (const node of nodes) {
    if (node.parentId !== undefined && !ids.has(node.parentId)) {
      return { ok: false, code: 'parent-node-missing' };
    }
  }
  return { ok: true, nodes: [...nodes] };
}

function validateNode(
  value: unknown,
): { ok: true; node: RawAcquiredNode } | { ok: false; code: string } {
  const node = asNodeRecord(value);
  if (!node) return { ok: false, code: 'node-not-object' };
  const code = nodeValidationCode(node);
  return code === undefined ? { ok: true, node: node as RawAcquiredNode } : { ok: false, code };
}

function asNodeRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function nodeValidationCode(value: Record<string, unknown>): string | undefined {
  const identityCode = nodeIdentityCode(value);
  if (identityCode) return identityCode;
  return nodeFactCode(value);
}

function nodeIdentityCode(value: Record<string, unknown>): string | undefined {
  if (Object.keys(value).some((key) => !NODE_KEYS.has(key))) {
    return 'node-contains-presentation-fact';
  }
  if (typeof value.id !== 'string' || value.id.length === 0) return 'node-id-missing';
  if (value.parentId !== undefined && typeof value.parentId !== 'string') {
    return 'parent-id-invalid';
  }
  return undefined;
}

function nodeFactCode(value: Record<string, unknown>): string | undefined {
  const textCode = optionalStringCode(value);
  if (textCode) return textCode;
  const booleanCode = optionalBooleanCode(value);
  if (booleanCode) return booleanCode;
  return value.frame !== undefined && !validateRect(value.frame) ? 'frame-invalid' : undefined;
}

function optionalStringCode(value: Record<string, unknown>): string | undefined {
  for (const key of ['type', 'role', 'subrole', 'label', 'value', 'identifier'] as const) {
    if (value[key] !== undefined && typeof value[key] !== 'string') return `${key}-invalid`;
  }
  return undefined;
}

function optionalBooleanCode(value: Record<string, unknown>): string | undefined {
  for (const key of ['enabled', 'selected', 'focused'] as const) {
    if (value[key] !== undefined && typeof value[key] !== 'boolean') return `${key}-invalid`;
  }
  return undefined;
}

function validateViewport(value: unknown): boolean {
  if (!isRecord(value) || typeof value.kind !== 'string') return false;
  if (value.kind === 'missing') {
    return (
      value.reason === 'not-provided' ||
      value.reason === 'not-supported' ||
      value.reason === 'invalid'
    );
  }
  return (value.kind === 'reported' || value.kind === 'derived') && validateRect(value.rect);
}

function validateRect(value: unknown): value is SpikeRect {
  if (!isRecord(value)) return false;
  for (const key of ['x', 'y', 'width', 'height']) {
    if (typeof value[key] !== 'number' || !Number.isFinite(value[key])) return false;
  }
  const width = value.width;
  const height = value.height;
  return typeof width === 'number' && typeof height === 'number' && width >= 0 && height >= 0;
}

function validateResidue(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  for (const residue of value) {
    if (!validateResidueItem(residue)) return false;
  }
  return true;
}

const RESIDUE_VALIDATORS: Readonly<Record<string, (value: Record<string, unknown>) => boolean>> = {
  'provider-pruned': (value) =>
    Array.isArray(value.fields) && value.fields.every((field) => typeof field === 'string'),
  'missing-viewport': (value) =>
    ['not-provided', 'not-supported', 'invalid'].includes(String(value.reason)),
  truncated: (value) => ['nodes', 'depth', 'payload'].includes(String(value.dimension)),
  'stale-generation': (value) => value.expected === undefined || typeof value.expected === 'string',
  'unavailable-fact': (value) => typeof value.fact === 'string',
  'fallback-source': (value) => typeof value.producer === 'string',
};

function validateResidueItem(value: unknown): boolean {
  if (!isRecord(value) || typeof value.kind !== 'string') return false;
  return RESIDUE_VALIDATORS[value.kind]?.(value) ?? false;
}

function treeDepth(nodes: readonly RawAcquiredNode[]): number {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const memo = new Map<string, number>();
  const visiting = new Set<string>();
  let maximum = 0;
  for (const node of nodes) maximum = Math.max(maximum, depth(node.id));
  return maximum;

  function depth(id: string): number {
    const cached = memo.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) return Number.POSITIVE_INFINITY;
    visiting.add(id);
    const parentId = byId.get(id)?.parentId;
    const result = parentId === undefined ? 0 : depth(parentId) + 1;
    visiting.delete(id);
    memo.set(id, result);
    return result;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
