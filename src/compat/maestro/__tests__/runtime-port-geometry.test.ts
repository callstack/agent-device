import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { resolveMaestroCoordinate } from '../runtime-port-geometry.ts';

// Bug class 1 (#1217), runtime half: upstream Maestro converts percentage
// coordinates to pixels by integer division (Maestro.kt), so the result is
// TRUNCATED, never rounded. The parse-level half (rejecting decimal percentages)
// is covered by the conformance oracle's layer-1 corpus.
//
// This is deliberately a unit test rather than a layer-3 device scenario:
// truncation and rounding differ by at most one pixel, which no app-observable
// outcome on a real device can distinguish. A pure test of the conversion pins it
// exactly. `resolveMaestroCoordinate` short-circuits on a known viewport, so no
// port or device is involved.
describe('resolveMaestroCoordinate percentage conversion', () => {
  const viewport = (width: number, height: number, x = 0, y = 0) => ({ x, y, width, height });
  const resolve = (percent: { x: number; y: number }, vp: ReturnType<typeof viewport>) =>
    resolveMaestroCoordinate(
      { space: 'percent', x: percent.x, y: percent.y },
      undefined as never,
      undefined as never,
      vp,
    );

  test('truncates rather than rounds when the pixel is fractional', async () => {
    // 1125 * 50 / 100 = 562.5 -> trunc 562 (rounding would give 563)
    // 2436 * 33 / 100 = 803.88 -> trunc 803 (rounding would give 804)
    const point = await resolve({ x: 50, y: 33 }, viewport(1125, 2436));
    assert.deepEqual(point, { x: 562, y: 803 });
  });

  test('truncates fractions above .5, where rounding would go up', async () => {
    // Both fractions round UP, so these only pass under truncation:
    // 1179 * 5 / 100 = 58.95 -> trunc 58 (round -> 59)
    // 2556 * 35 / 100 = 894.6 -> trunc 894 (round -> 895)
    const point = await resolve({ x: 5, y: 35 }, viewport(1179, 2556));
    assert.deepEqual(point, { x: 58, y: 894 });
  });

  test('is exact when the pixel is whole', async () => {
    const point = await resolve({ x: 50, y: 25 }, viewport(1080, 1920));
    assert.deepEqual(point, { x: 540, y: 480 });
  });

  test('adds the viewport origin after truncating the fraction', async () => {
    // Origin is added to the truncated span, not truncated together with it.
    const point = await resolve({ x: 50, y: 50 }, viewport(1125, 2436, 7, 11));
    assert.deepEqual(point, { x: 7 + 562, y: 11 + 1218 });
  });

  test('0% and 100% map to the viewport edges', async () => {
    assert.deepEqual(await resolve({ x: 0, y: 0 }, viewport(1125, 2436)), { x: 0, y: 0 });
    assert.deepEqual(await resolve({ x: 100, y: 100 }, viewport(1125, 2436)), { x: 1125, y: 2436 });
  });

  test('absolute coordinates pass through untouched', async () => {
    const point = await resolveMaestroCoordinate(
      { space: 'absolute', x: 100, y: 200 },
      undefined as never,
      undefined as never,
      viewport(1125, 2436),
    );
    assert.deepEqual(point, { x: 100, y: 200 });
  });
});
