import { unsupportedMaestroSyntax } from './support.ts';

export type MaestroPoint =
  | {
      kind: 'absolute';
      x: number;
      y: number;
    }
  | {
      kind: 'percent';
      x: number;
      y: number;
    };

export function parseAbsolutePoint(value: string): { x: number; y: number } {
  const match = value.match(/^(\d+),(\d+)$/);
  if (!match) {
    throw unsupportedMaestroSyntax(
      'Only absolute Maestro point selectors like "100,200" are supported.',
    );
  }
  return { x: Number(match[1]), y: Number(match[2]) };
}

export function parseMaestroPoint(value: string): MaestroPoint {
  const absolute = value.match(/^\s*(\d+)\s*,\s*(\d+)\s*$/);
  if (absolute) {
    return { kind: 'absolute', x: Number(absolute[1]), y: Number(absolute[2]) };
  }
  const percent = value.match(/^\s*(\d+(?:\.\d+)?)%\s*,\s*(\d+(?:\.\d+)?)%\s*$/);
  if (percent) {
    return { kind: 'percent', x: Number(percent[1]), y: Number(percent[2]) };
  }
  throw unsupportedMaestroSyntax(
    'Only Maestro swipe coordinates like "100,200" or "50%,75%" are supported.',
  );
}
