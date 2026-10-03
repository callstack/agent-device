import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PNG } from '@agent-device/capture-kit/png';

/**
 * The captures and crop boxes this benchmark measures. They are generated rather than recorded,
 * so a run costs seconds and needs no device; each one reports its own compressed size, which is
 * how a corpus that stopped resembling a real capture becomes visible instead of flattering.
 * Pass real captures with `--file` to put their numbers in the same table.
 */

export type CaptureResolution = Readonly<{
  name: string;
  label: string;
  width: number;
  height: number;
}>;

const RESOLUTIONS: readonly CaptureResolution[] = [
  { name: 'ios-phone', label: 'iPhone-class 1206x2622', width: 1206, height: 2622 },
  { name: 'android-phone', label: 'Android-class 1080x2400', width: 1080, height: 2400 },
  { name: 'ios-pad', label: 'iPad-class 2048x2732', width: 2048, height: 2732 },
];

export type Capture = Readonly<{
  name: string;
  label: string;
  width: number;
  height: number;
  bytes: Buffer;
}>;

export type CropScenario = Readonly<{
  name: string;
  /** Fractions of the capture, so one scenario reads well at every resolution. */
  fraction: Readonly<{ x: number; y: number; width: number; height: number }>;
}>;

/** The box shapes `--crop-on` resolves: a card, a full-bleed header, and a small control. */
export const CROP_SCENARIOS: readonly CropScenario[] = [
  { name: 'card', fraction: { x: 0.08, y: 0.25, width: 0.8, height: 0.2 } },
  { name: 'header', fraction: { x: 0, y: 0, width: 1, height: 0.12 } },
  { name: 'control', fraction: { x: 0.3, y: 0.6, width: 0.3, height: 0.04 } },
];

export function buildCorpus(
  outDir: string,
  resolutions: readonly CaptureResolution[] = RESOLUTIONS,
): Capture[] {
  mkdirSync(outDir, { recursive: true });
  return resolutions.flatMap(({ name, label, width, height }) =>
    (['interface', 'photo'] as const).map((kind) => {
      const bytes = PNG.sync.write(encodeCapture(width, height, kind));
      writeFileSync(path.join(outDir, `${name}-${kind}.png`), bytes);
      return { name: `${name}-${kind}`, label: `${label} ${kind}`, width, height, bytes };
    }),
  );
}

export function readCaptureFile(filePath: string, index: number): Capture {
  const bytes = readFileSync(filePath);
  const png = PNG.sync.read(bytes);
  return {
    name: `capture-${index}`,
    label: path.basename(filePath),
    width: png.width,
    height: png.height,
    bytes,
  };
}

type Content = 'interface' | 'photo';

/**
 * A capture a device could have produced. `interface` is flat panels with high-frequency text
 * where the copy is drawn, which is what a settings or list screen looks like. `photo` is
 * low-frequency detail in 8px blocks plus a gradient, which is what a photo, artwork, or a blurred
 * background does to the deflate stream.
 */
function encodeCapture(width: number, height: number, content: Content): PNG {
  const png = new PNG({ width, height });
  const tones = content === 'photo' ? photoToneField(width, height) : null;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const [red, green, blue] = tones ? photoPixel(tones, x, y) : interfacePixel(x, y);
      png.data[offset] = red;
      png.data[offset + 1] = green;
      png.data[offset + 2] = blue;
      png.data[offset + 3] = 255;
    }
  }
  return png;
}

/** Flat panels with high-frequency text where the copy is drawn. */
function interfacePixel(x: number, y: number): readonly [number, number, number] {
  const ink = x % 320 < 2 || y % 96 < 2 || (y % 24 > 6 && y % 24 < 18 && x % 7 < 3);
  if (ink) return [24, 26, 30];
  const band = Math.floor(y / 96);
  return [(band * 11) % 240, (band * 17) % 244, (band * 23) % 248];
}

/** The 8px-block detail and soft gradient of a photo, scaled by the pixel position. */
function photoPixel(
  tones: readonly (readonly number[])[],
  x: number,
  y: number,
): readonly [number, number, number] {
  const tone = tones[y >> 3]?.[x >> 3] ?? 0;
  return [
    clampByte(tone + y / 6),
    clampByte(tone * 0.8 + x / 9),
    clampByte(tone * 0.6 + (x + y) / 24),
  ];
}

/** Smooth 8px-block luminance in [40, 215], so a photo corpus compresses like a real photo. */
function photoToneField(width: number, height: number): number[][] {
  let state = 0x9e3779b9;
  const next = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  return Array.from({ length: Math.ceil(height / 8) }, (_row, blockRow) =>
    Array.from({ length: Math.ceil(width / 8) }, (_column, blockColumn) => {
      const drift = Math.sin(blockRow / 26) * 45 + Math.cos(blockColumn / 19) * 45;
      return clampByte(128 + drift + (next() - 0.5) * 70);
    }),
  );
}

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

export function cropBoxOf(
  capture: Capture,
  scenario: CropScenario,
): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  const { fraction } = scenario;
  const x = Math.round(capture.width * fraction.x);
  const y = Math.round(capture.height * fraction.y);
  return {
    x,
    y,
    width: Math.max(1, Math.min(capture.width - x, Math.round(capture.width * fraction.width))),
    height: Math.max(1, Math.min(capture.height - y, Math.round(capture.height * fraction.height))),
  };
}
