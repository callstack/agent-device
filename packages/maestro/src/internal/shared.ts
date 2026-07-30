import { AppError } from '@agent-device/kernel/errors';
import type { Point, Rect, SnapshotNode } from '@agent-device/kernel/snapshot';

export function stripUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, sortKeysDeep(record[key])]),
  );
}

export function pointInsideRect(rect: Rect): Point {
  return {
    x: interiorCoordinate(rect.x, rect.width),
    y: interiorCoordinate(rect.y, rect.height),
  };
}

function interiorCoordinate(origin: number, size: number): number {
  if (size <= 1) return Math.floor(origin);
  const min = Math.ceil(origin);
  const max = Math.floor(origin + size - 1);
  return Math.round(Math.min(max, Math.max(min, origin + size / 2)));
}

export function normalizeText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

export function extractNodeText(node: SnapshotNode): string {
  return (
    [node.label, node.value, node.identifier]
      .find((candidate) => typeof candidate === 'string' && candidate.length > 0)
      ?.trim() ?? ''
  );
}

export function createRequestCanceledError(): AppError {
  return new AppError('COMMAND_FAILED', 'request canceled', {
    reason: 'request_canceled',
    hint: 'The request was canceled intentionally (explicit cancel or client disconnect) — no retry is needed unless the cancellation was unintended.',
  });
}
