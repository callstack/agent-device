import { resolveRectCenter } from '@agent-device/kernel/rect-center';

export function parseCoordinateTarget(positionals: string[]): { x: number; y: number } | null {
  if (positionals.length < 2) return null;
  const x = Number(positionals[0]);
  const y = Number(positionals[1]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

export { resolveRectCenter };
