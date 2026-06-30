import { describe, expect, test } from 'vitest';
import { managementCliOutputFormatters, openCliOutput } from './output.ts';

describe('openCliOutput', () => {
  test('prints session state directory on a second line', () => {
    const output = openCliOutput({
      session: 'default',
      sessionStateDir: '/tmp/agent-device/sessions/cwd_123_default',
      identifiers: { session: 'default' },
    });

    expect(output.text).toBe(
      ['Opened: default', 'Session state: /tmp/agent-device/sessions/cwd_123_default'].join('\n'),
    );
    expect(output.data).toMatchObject({
      session: 'default',
      sessionStateDir: '/tmp/agent-device/sessions/cwd_123_default',
    });
  });
});

describe('artifactsCliOutput', () => {
  test('prints ready artifact URLs and preserves JSON data', () => {
    const output = managementCliOutputFormatters.artifacts({
      input: {},
      result: {
        provider: 'browserstack',
        providerSessionId: 'wd-1',
        status: 'ready',
        cloudArtifacts: [
          {
            provider: 'browserstack',
            providerSessionId: 'wd-1',
            kind: 'video',
            name: 'Session video',
            url: 'https://provider.example/video.mp4',
            availability: 'ready',
          },
        ],
      },
    });

    expect(output.text).toBe('video: Session video ready https://provider.example/video.mp4');
    expect(output.data).toMatchObject({
      cloudArtifacts: [{ url: 'https://provider.example/video.mp4' }],
    });
  });

  test('prints exact retry command for pending provider sessions', () => {
    const output = managementCliOutputFormatters.artifacts({
      input: {},
      result: {
        provider: 'aws-device-farm',
        providerSessionId: 'arn:aws:devicefarm:us-west-2:123:session/project/session/00000',
        status: 'pending',
        cloudArtifacts: [],
        message: 'AWS Device Farm artifacts are not ready yet.',
      },
    });

    expect(output.text).toBe(
      [
        'AWS Device Farm artifacts are not ready yet.',
        'Retry: agent-device artifacts arn:aws:devicefarm:us-west-2:123:session/project/session/00000 --provider aws-device-farm --json',
      ].join('\n'),
    );
  });
});
