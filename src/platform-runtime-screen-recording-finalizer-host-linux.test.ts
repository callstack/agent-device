import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, test } from 'vitest';
import { createTestHostEnvironment, mkdtempForTestSync } from '@agent-device/test-kit';
import { createVideoValidatorPreparation } from '@agent-device/capture-kit/recording-video';
import { createScreenRecordingFinalizer } from './platform-runtime-screen-recording-finalizer-host.ts';

// One H.264 frame extracted from website/docs/public/agent-device-contacts.mp4.
const mp4 = Buffer.from(
  'AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAMcbW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAABEAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAkd0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAABEAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAACAAAAAgAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAAARAAAAAAABAAAAAAG/bWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAAA8AAAAAQBVxAAAAAAAL2hkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABtcDQtbXV4ZXItaGRscgAAAAFobWluZgAAABR2bWhkAAAAAQAAAAAAAAAAAAAAJGRpbmYAAAAcZHJlZgAAAAAAAAABAAAADHVybCAAAAABAAABKHN0YmwAAADEc3RzZAAAAAAAAAABAAAAtGF2YzEAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAIAAgAEgAAABIAAAAAAAAAAEUTGF2YzYzLjEuMTAyIGxpYngyNjQAAAAAAAAAAAAAAAAY//8AAAA3YXZjQwFkAAr/4QAaZ2QACqzZSWmoCAgKAAADAAIAAAMA8B4kSywBAAZo6+PLIsD9+PgAAAAAE2NvbHJuY2x4AAEAAQABAAAAABRidHJ0AAAAAAAFoeAAAAAAAAAAGHN0dHMAAAAAAAAAAQAAAAEAAAEAAAAAHHN0c2MAAAAAAAAAAQAAAAEAAAABAAAAAQAAABRzdHN6AAAAAAAAAwEAAAABAAAAFHN0Y28AAAAAAAAAAQAAA0wAAABhdWR0YQAAAFltZXRhAAAAAAAAACFoZGxyAAAAAAAAAABtZGlyYXBwbAAAAAAAAAAAAAAAACxpbHN0AAAAJKl0b28AAAAcZGF0YQAAAAEAAAAATGF2ZjYzLjEuMTAyAAAACGZyZWUAAAMJbWRhdAAAAq4GBf//qtxF6b3m2Ui3lizYINkj7u94MjY0IC0gY29yZSAxNjUgcjMyMjIgYjM1NjA1YSAtIEguMjY0L01QRUctNCBBVkMgY29kZWMgLSBDb3B5bGVmdCAyMDAzLTIwMjUgLSBodHRwOi8vd3d3LnZpZGVvbGFuLm9yZy94MjY0Lmh0bWwgLSBvcHRpb25zOiBjYWJhYz0xIHJlZj0zIGRlYmxvY2s9MTowOjAgYW5hbHlzZT0weDM6MHgxMTMgbWU9aGV4IHN1Ym1lPTcgcHN5PTEgcHN5X3JkPTEuMDA6MC4wMCBtaXhlZF9yZWY9MSBtZV9yYW5nZT0xNiBjaHJvbWFfbWU9MSB0cmVsbGlzPTEgOHg4ZGN0PTEgY3FtPTAgZGVhZHpvbmU9MjEsMTEgZmFzdF9wc2tpcD0xIGNocm9tYV9xcF9vZmZzZXQ9LTIgdGhyZWFkcz0xIGxvb2thaGVhZF90aHJlYWRzPTEgc2xpY2VkX3RocmVhZHM9MCBucj0wIGRlY2ltYXRlPTEgaW50ZXJsYWNlZD0wIGJsdXJheV9jb21wYXQ9MCBjb25zdHJhaW5lZF9pbnRyYT0wIGJmcmFtZXM9MyBiX3B5cmFtaWQ9MiBiX2FkYXB0PTEgYl9iaWFzPTAgZGlyZWN0PTEgd2VpZ2h0Yj0xIG9wZW5fZ29wPTAgd2VpZ2h0cD0yIGtleWludD0yNTAga2V5aW50X21pbj0yNSBzY2VuZWN1dD00MCBpbnRyYV9yZWZyZXNoPTAgcmNfbG9va2FoZWFkPTQwIHJjPWNyZiBtYnRyZWU9MSBjcmY9MjMuMCBxY29tcD0wLjYwIHFwbWluPTAgcXBtYXg9NjkgcXBzdGVwPTQgaXBfcmF0aW89MS40MCBhcT0xOjEuMDAAgAAAAEtliIQAIf/5DlGZN4dVyDdh3UwkBreEv6soXilcHMmqGadHZLJ0bOaxUMbRRwM5bTHYdaDnudXg0OhSPZ5XYqDxXGdIUQ+sQe6twis=',
  'base64',
);

test.skipIf(process.platform !== 'linux')(
  'Linux finalizes an MP4 with container authority and no Swift tools',
  async () => {
    console.log(`Recording finalizer evidence: process.platform=${process.platform}`);
    const root = mkdtempForTestSync('recording-linux-');
    const bin = path.join(root, 'bin');
    const cache = path.join(root, 'swift-cache');
    fs.mkdirSync(bin);
    const host = createTestHostEnvironment({
      env: {
        ...process.env,
        PATH: bin,
        AGENT_DEVICE_SWIFT_CACHE_DIR: cache,
        AGENT_DEVICE_CLAIMS_DIR: path.join(root, 'claims'),
      },
    });
    for (const command of ['swift', 'swiftc', 'xcrun']) {
      expect(spawnSync(command, [], { env: host.env }).error).toMatchObject({ code: 'ENOENT' });
    }

    const outputPath = path.join(root, 'recording.mp4');
    fs.writeFileSync(outputPath, mp4);
    const raw = fs.readFileSync(outputPath);
    const preparation = createVideoValidatorPreparation(host);
    const finalizer = createScreenRecordingFinalizer(host, preparation);
    const gestureEvents = [{ kind: 'tap' as const, tMs: 0, x: 10, y: 20 }];
    try {
      await finalizer.prepare({ container: 'mp4' });
      expect(await preparation.read()).toEqual({ kind: 'container' });
      await finalizer.sniff({ outputPath });
      const result = await finalizer.complete({
        outputPath,
        showTouches: true,
        gestureEvents,
        targetLabel: 'test recording',
      });
      expect(result.overlayWarning).toBe(
        'touch overlay burn-in is only available on macOS hosts; returning raw video plus gesture telemetry',
      );
      expect(fs.readFileSync(outputPath)).toEqual(raw);
      expect(JSON.parse(fs.readFileSync(result.telemetryPath!, 'utf8'))).toMatchObject({
        version: 1,
        events: gestureEvents,
      });
      expect(fs.existsSync(cache)).toBe(false);
    } finally {
      await preparation.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
