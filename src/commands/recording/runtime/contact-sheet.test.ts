import assert from 'node:assert/strict';
import { beforeEach, test, vi } from 'vitest';
import {
  buildRecordingContactSheet,
  CONTACT_SHEET_THRESHOLD_REASON,
} from '@agent-device/capture-kit/recording-contact-sheet';
import type { ArtifactAdapter, ArtifactDescriptor, FileInputRef } from '../../../io.ts';
import {
  createAgentDevice,
  localCommandPolicy,
  restrictedCommandPolicy,
} from '../../../runtime.ts';

vi.mock('@agent-device/capture-kit/recording-contact-sheet', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent-device/capture-kit/recording-contact-sheet')>()),
  buildRecordingContactSheet: vi.fn(),
}));

const mockBuild = vi.mocked(buildRecordingContactSheet);

let reserved: { path: string; cleaned: boolean; published: boolean }[] = [];
let materializedCleanups = 0;

const artifacts = {
  resolveInput: async (ref: FileInputRef) => ({
    path: ref.kind === 'path' ? ref.path : `/tmp/uploaded/${ref.id}.mp4`,
    cleanup:
      ref.kind === 'uploadedArtifact'
        ? async () => {
            materializedCleanups += 1;
          }
        : undefined,
  }),
  reserveOutput: async (ref, options) => {
    const path = ref?.kind === 'path' ? ref.path : `/tmp/${options.field}${options.ext}`;
    const reservation = { path, cleaned: false, published: false };
    reserved.push(reservation);
    return {
      path,
      visibility: options.visibility ?? 'client-visible',
      publish: async (): Promise<ArtifactDescriptor> => {
        reservation.published = true;
        return ref?.kind === 'path'
          ? {
              kind: 'localPath',
              field: options.field,
              artifactType: options.artifactType,
              path,
            }
          : {
              kind: 'artifact',
              field: options.field,
              artifactType: options.artifactType,
              artifactId: 'artifact-1',
              clientPath: '/Users/me/Downloads/sheet.png',
            };
      },
      cleanup: async () => {
        reservation.cleaned = true;
      },
    };
  },
  createTempFile: async (options) => ({
    path: `/tmp/${options.prefix}${options.ext}`,
    visibility: 'internal' as const,
    cleanup: async () => {},
  }),
} satisfies ArtifactAdapter;

function sheetResult(path: string) {
  return {
    path,
    videoPath: '/tmp/recording.mp4',
    durationMs: 1000,
    width: 744,
    height: 218,
    sampledFrameCount: 5,
    decodedFrameCount: 5,
    skippedSampleCount: 0,
    changedPixelThreshold: 0.02,
    cells: [{ timeMs: 0, changedPixelRatio: 1 }],
  };
}

function device(policy = localCommandPolicy()) {
  return createAgentDevice({ backend: { platform: 'ios' }, artifacts, policy });
}

beforeEach(() => {
  reserved = [];
  materializedCleanups = 0;
  mockBuild.mockReset();
  mockBuild.mockImplementation(async (input) => sheetResult(input.outputPath ?? 'unset'));
});

test('record contact-sheet defaults to the sheet beside the recording it was given', async () => {
  const result = await device().recording.contactSheet({
    video: { kind: 'path', path: '/tmp/recording.mp4' },
  });

  assert.equal(mockBuild.mock.calls[0]![0].outputPath, '/tmp/recording.contact-sheet.png');
  assert.equal(result.path, '/tmp/recording.contact-sheet.png');
  assert.equal(result.artifact?.kind, 'localPath');
  assert.equal(reserved[0]?.published, true);
  assert.equal(reserved[0]?.cleaned, false);
});

test('record contact-sheet passes the pixel budget and honours an explicit output', async () => {
  await device().recording.contactSheet({
    video: { kind: 'path', path: '/tmp/recording.mp4' },
    out: { kind: 'path', path: '/tmp/named/sheet.png' },
    changedPixelThreshold: 0.2,
  });

  const input = mockBuild.mock.calls[0]![0];
  assert.equal(input.outputPath, '/tmp/named/sheet.png');
  assert.equal(input.maxPixels, 20_000_000);
  assert.equal(input.changedPixelThreshold, 0.2);
});

test('record contact-sheet reports the caller-visible path of a downloaded artifact', async () => {
  const result = await device().recording.contactSheet({
    video: { kind: 'uploadedArtifact', id: 'rec-1' },
    out: { kind: 'downloadableArtifact' },
  });

  assert.equal(result.path, '/Users/me/Downloads/sheet.png');
  assert.equal(result.artifact?.kind, 'artifact');
});

test('record contact-sheet requires an output when the recording has no caller-side sibling', async () => {
  await assert.rejects(
    () =>
      device().recording.contactSheet({
        video: { kind: 'uploadedArtifact', id: 'rec-1' },
      }),
    /needs an output path/,
  );
  assert.equal(mockBuild.mock.calls.length, 0);
  // The recording was already downloaded to answer the call, so refusing must put it back.
  assert.equal(materializedCleanups, 1);
});

test('record contact-sheet releases a downloaded recording once the sheet fails', async () => {
  mockBuild.mockRejectedValue(new Error('decoder refused the clip'));

  await assert.rejects(
    () =>
      device().recording.contactSheet({
        video: { kind: 'uploadedArtifact', id: 'rec-1' },
        out: { kind: 'downloadableArtifact' },
      }),
    /decoder refused the clip/,
  );

  assert.equal(materializedCleanups, 1);
});

test('record contact-sheet refuses a change threshold that is not a share of the frame', async () => {
  for (const changedPixelThreshold of [Number.NaN, -0.1, 1.5]) {
    await assert.rejects(
      () =>
        device().recording.contactSheet({
          video: { kind: 'path', path: '/tmp/recording.mp4' },
          changedPixelThreshold,
        }),
      (error: unknown) =>
        (error as { details?: { reason?: string } }).details?.reason ===
        CONTACT_SHEET_THRESHOLD_REASON,
    );
  }
  // Nothing is decoded for an argument that could only print every frame or none of them.
  assert.equal(mockBuild.mock.calls.length, 0);
});

test('record contact-sheet file paths are policy-gated on both sides', async () => {
  await assert.rejects(
    () =>
      device(restrictedCommandPolicy()).recording.contactSheet({
        video: { kind: 'path', path: '/tmp/recording.mp4' },
      }),
    /Local video paths are not allowed by command policy/,
  );
  await assert.rejects(
    () =>
      device(localCommandPolicy({ allowLocalOutputPaths: false })).recording.contactSheet({
        video: { kind: 'path', path: '/tmp/recording.mp4' },
        out: { kind: 'path', path: '/tmp/sheet.png' },
      }),
    /Local output paths are not allowed by command policy/,
  );
});

test('a failed sheet releases the output it reserved', async () => {
  mockBuild.mockRejectedValue(new Error('decoder refused the clip'));

  await assert.rejects(
    () =>
      device().recording.contactSheet({
        video: { kind: 'path', path: '/tmp/recording.mp4' },
      }),
    /decoder refused the clip/,
  );

  assert.equal(reserved[0]?.cleaned, true);
  assert.equal(reserved[0]?.published, false);
});

test('record contact-sheet needs a recording to read', async () => {
  await assert.rejects(
    () => device().recording.contactSheet({ video: undefined as never }),
    /requires a recording/,
  );
});
