import { describe, expect, test } from 'vitest';
import { createHarmonyHdcRunnerStub } from '../toolbox.fixtures.ts';
import { createHarmonyScreenRecorder } from './recorder.ts';

const device = {
  platform: 'harmonyos' as const,
  id: 'harmony-device',
  name: 'Harmony device',
  kind: 'device' as const,
  target: 'mobile' as const,
  booted: true,
};

describe('the HarmonyOS screen recorder', () => {
  test('removes staged media only after HDC confirms', async () => {
    const hdc = createHarmonyHdcRunnerStub([{ exitCode: 1, stderr: 'permission denied' }]);
    const recorder = createHarmonyScreenRecorder(hdc);

    await expect(recorder.remove(device, '/data/local/tmp/capture.mp4')).resolves.toBe(false);
    expect(hdc.calls[0]).toMatchObject({
      kind: 'runShell',
      target: 'harmony-device',
      args: ['rm', '-f', '/data/local/tmp/capture.mp4'],
      options: { allowFailure: true },
    });
  });

  test('reads the staged byte count from focused HDC stat output', async () => {
    const hdc = createHarmonyHdcRunnerStub([{ stdout: '12345\n' }]);
    const recorder = createHarmonyScreenRecorder(hdc);

    await expect(recorder.stagedFileSize(device, '/data/local/tmp/capture.mp4')).resolves.toBe(
      12_345,
    );
    expect(hdc.calls[0]?.args).toEqual(['stat', '-c', '%s', '/data/local/tmp/capture.mp4']);
  });

  test('treats a failed or unusable stat as no staged size', async () => {
    const failing = createHarmonyScreenRecorder(createHarmonyHdcRunnerStub([{ exitCode: 1 }]));
    await expect(failing.stagedFileSize(device, '/data/local/tmp/capture.mp4')).resolves.toBe(
      undefined,
    );

    const unreadable = createHarmonyScreenRecorder(
      createHarmonyHdcRunnerStub([{ stdout: 'not-a-size\n' }]),
    );
    await expect(unreadable.stagedFileSize(device, '/data/local/tmp/capture.mp4')).resolves.toBe(
      undefined,
    );
  });

  test('reads the media uri the device reports for the recorded file name', async () => {
    const hdc = createHarmonyHdcRunnerStub([
      { stdout: 'FileID: 12 file://media/Video/record.mp4\n' },
    ]);
    const recorder = createHarmonyScreenRecorder(hdc);

    await expect(recorder.findMedia(device, 'record.mp4')).resolves.toBe(
      'file://media/Video/record.mp4',
    );
    expect(hdc.calls[0]?.args).toEqual(['mediatool', 'query', 'record.mp4', '-u']);
  });

  test('starts and stops the recorder ability through the shell route', async () => {
    const hdc = createHarmonyHdcRunnerStub();
    const recorder = createHarmonyScreenRecorder(hdc);

    await recorder.start(device, 'record.mp4');
    await recorder.stop(device);

    expect(hdc.calls.map((call) => call.args)).toEqual([
      [
        'aa',
        'start',
        '-b',
        'com.huawei.hmos.screenrecorder',
        '-a',
        'com.huawei.hmos.screenrecorder.ServiceExtAbility',
        '--ps',
        'CustomizedFileName',
        'record.mp4',
      ],
      [
        'aa',
        'start',
        '-b',
        'com.huawei.hmos.screenrecorder',
        '-a',
        'com.huawei.hmos.screenrecorder.ServiceExtAbility',
      ],
    ]);
  });

  test('stages and pulls media through the documented HDC file commands', async () => {
    const hdc = createHarmonyHdcRunnerStub();
    const recorder = createHarmonyScreenRecorder(hdc);

    await expect(
      recorder.stageMedia(device, {
        mediaUri: 'file://media/Video/record.mp4',
        remotePath: '/data/local/tmp/capture.mp4',
      }),
    ).resolves.toBe(true);
    await recorder.pull(device, {
      remotePath: '/data/local/tmp/capture.mp4',
      outputPath: '/tmp/capture.mp4',
    });

    expect(hdc.calls.map((call) => [call.kind, call.args])).toEqual([
      [
        'runShell',
        ['mediatool', 'recv', 'file://media/Video/record.mp4', '/data/local/tmp/capture.mp4'],
      ],
      ['run', ['file', 'recv', '/data/local/tmp/capture.mp4', '/tmp/capture.mp4']],
    ]);
  });

  test('reports media removal only when the device confirms the delete', async () => {
    const removed = createHarmonyHdcRunnerStub();
    await expect(
      createHarmonyScreenRecorder(removed).removeMedia(device, 'file://media/Video/record.mp4'),
    ).resolves.toBe(true);
    expect(removed.calls[0]?.args).toEqual([
      'mediatool',
      'delete',
      'file://media/Video/record.mp4',
    ]);

    const refused = createHarmonyHdcRunnerStub([{ exitCode: 1 }]);
    await expect(
      createHarmonyScreenRecorder(refused).removeMedia(device, 'file://media/Video/record.mp4'),
    ).resolves.toBe(false);
  });
});
