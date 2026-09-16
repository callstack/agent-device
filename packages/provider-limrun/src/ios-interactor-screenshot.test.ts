import fs from 'node:fs';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { readPngSize } from '@agent-device/capture-kit/png-size';
import { createLimrunIosInteractor, type LimrunIosSession } from './ios.ts';
import { mkdtempForTestSync } from './tmp-dir.fixtures.ts';

/** An 8x6 mid-gray JPEG at quality 90: the container Limrun serves its captures in. */
const JPEG_8X6_BASE64 = [
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wCEAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4R',
  'DgsLEBYQERMUFRUVDA8XGBYUGBIUFRQBAwQEBQQFCQUFCRQNCw0UFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQU',
  'FBQUFBQUFBQUFBQUFBQUFBQUFBQUFP/AABEIAAYACAMBEQACEQEDEQH/xAGiAAABBQEBAQEBAQAAAAAAAAAAAQID',
  'BAUGBwgJCgsQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYX',
  'GBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqi',
  'o6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+gEAAwEBAQEBAQEB',
  'AQAAAAAAAAECAwQFBgcICQoLEQACAQIEBAMEBwUEBAABAncAAQIDEQQFITEGEkFRB2FxEyIygQgUQpGhscEJIzNS',
  '8BVictEKFiQ04SXxFxgZGiYnKCkqNTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqCg4SFhoeI',
  'iYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2dri4+Tl5ufo6ery8/T19vf4+fr/',
  '2gAMAwEAAhEDEQA/ACgD/9k=',
].join('');

function sessionWithScreenshot(base64: string) {
  const client = {
    screenshot: vi.fn(async () => ({ base64, width: 402, height: 874 })),
  };
  const session = {
    platform: 'ios',
    instanceId: 'limrun-screenshot-instance',
    client,
  } as unknown as LimrunIosSession;
  return { interactor: createLimrunIosInteractor(session), client };
}

test('the JPEG Limrun serves is written to the PNG path as a PNG of the same size', async () => {
  const outPath = path.join(mkdtempForTestSync('agent-device-limrun-screenshot-'), 'shot.png');
  const { interactor } = sessionWithScreenshot(JPEG_8X6_BASE64);

  await interactor.screenshot(outPath);

  const bytes = fs.readFileSync(outPath);
  expect(bytes.subarray(0, 8)).toEqual(
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  );
  await expect(readPngSize(outPath)).resolves.toEqual({ width: 8, height: 6 });
});

test('a capture that is neither PNG nor JPEG is refused instead of written', async () => {
  const outPath = path.join(mkdtempForTestSync('agent-device-limrun-screenshot-'), 'shot.png');
  const { interactor } = sessionWithScreenshot(Buffer.from('not an image').toString('base64'));

  await expect(interactor.screenshot(outPath)).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    message: 'Limrun iOS screenshot is neither PNG nor JPEG',
  });
  expect(fs.existsSync(outPath)).toBe(false);
});

test('a JPEG header over a body that does not decode is refused with the typed decode error', async () => {
  const outPath = path.join(mkdtempForTestSync('agent-device-limrun-screenshot-'), 'shot.png');
  const garbage = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 0x41)]);
  const { interactor } = sessionWithScreenshot(garbage.toString('base64'));

  await expect(interactor.screenshot(outPath)).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    message: 'Failed to decode Limrun iOS screenshot as JPEG',
  });
  expect(fs.existsSync(outPath)).toBe(false);
});
