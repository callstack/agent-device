import { promises as fs } from 'node:fs';
import { AppError } from '@agent-device/kernel/errors';
import { SCREENSHOT_SCALE_LIMITS } from '@agent-device/contracts/capture';
import { PNG } from './png.ts';
import { decodePngAsync, encodePngAsync } from './png-worker-client.ts';

/**
 * Resizes a PNG file in place by a proportional scale factor. Decode and
 * encode run on the PNG worker thread (daemon screenshot `--scale` path);
 * the in-memory box-filter resample itself is cheap enough to stay inline.
 */
export async function resizePngFileToScale(filePath: string, scale: number): Promise<void> {
  const { min, max } = SCREENSHOT_SCALE_LIMITS;
  if (!Number.isFinite(scale) || scale < min || scale > max) {
    throw new AppError('INVALID_ARGS', `Screenshot scale must be between ${min} and ${max}`);
  }
  if (scale === 1) return;

  const source = await decodePngAsync(await fs.readFile(filePath), 'screenshot');
  const width = Math.max(1, Math.round(source.width * scale));
  const height = Math.max(1, Math.round(source.height * scale));
  await fs.writeFile(filePath, await encodePngAsync(resizePngBox(source, width, height)));
}

export async function resizePngFile(
  filePath: string,
  width: number,
  height: number,
): Promise<void> {
  if (!Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1) {
    throw new AppError('INVALID_ARGS', 'Screenshot resize dimensions must be positive integers');
  }

  const source = await decodePngAsync(await fs.readFile(filePath), 'screenshot');
  if (source.width === width && source.height === height) {
    return;
  }

  await fs.writeFile(filePath, await encodePngAsync(resizePngBox(source, width, height)));
}

function resizePngBox(source: PNG, width: number, height: number): PNG {
  const output = new PNG({ width, height });
  for (let y = 0; y < height; y += 1) {
    const sourceTop = (y * source.height) / height;
    const sourceBottom = ((y + 1) * source.height) / height;
    for (let x = 0; x < width; x += 1) {
      const sourceLeft = (x * source.width) / width;
      const sourceRight = ((x + 1) * source.width) / width;

      let red = 0;
      let green = 0;
      let blue = 0;
      let alpha = 0;
      let weight = 0;

      for (let sourceY = Math.floor(sourceTop); sourceY < Math.ceil(sourceBottom); sourceY += 1) {
        const yWeight = Math.min(sourceY + 1, sourceBottom) - Math.max(sourceY, sourceTop);
        for (let sourceX = Math.floor(sourceLeft); sourceX < Math.ceil(sourceRight); sourceX += 1) {
          const pixelWeight =
            yWeight * (Math.min(sourceX + 1, sourceRight) - Math.max(sourceX, sourceLeft));
          const sourceOffset = (sourceY * source.width + sourceX) * 4;
          red += (source.data[sourceOffset] ?? 0) * pixelWeight;
          green += (source.data[sourceOffset + 1] ?? 0) * pixelWeight;
          blue += (source.data[sourceOffset + 2] ?? 0) * pixelWeight;
          alpha += (source.data[sourceOffset + 3] ?? 0) * pixelWeight;
          weight += pixelWeight;
        }
      }

      const outputOffset = (y * output.width + x) * 4;
      output.data[outputOffset] = Math.round(red / weight);
      output.data[outputOffset + 1] = Math.round(green / weight);
      output.data[outputOffset + 2] = Math.round(blue / weight);
      output.data[outputOffset + 3] = Math.round(alpha / weight);
    }
  }
  return output;
}
