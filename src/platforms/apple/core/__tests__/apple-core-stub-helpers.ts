import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { mkdtempForTest } from '../../../../__tests__/test-utils/tmp-dir.ts';

export const IOS_TEST_DEVICE: DeviceInfo = {
  platform: 'apple',
  id: 'ios-device-1',
  name: 'iPhone Device',
  kind: 'device',
  booted: true,
};

export const IOS_TEST_SIMULATOR: DeviceInfo = {
  platform: 'apple',
  id: 'sim-1',
  name: 'iPhone 17 Pro',
  kind: 'simulator',
  booted: true,
};

export const MACOS_TEST_DEVICE: DeviceInfo = {
  platform: 'apple',
  appleOs: 'macos',
  id: 'host-macos-local',
  name: 'Mac',
  kind: 'device',
  target: 'desktop',
  booted: true,
};

export const TVOS_TEST_SIMULATOR: DeviceInfo = {
  platform: 'apple',
  id: 'tvos-sim-1',
  name: 'Apple TV',
  kind: 'simulator',
  target: 'tv',
  booted: true,
};

export async function withMockedXcrun(
  tempPrefix: string,
  script: string,
  run: (ctx: { tmpDir: string; argsLogPath: string; device: DeviceInfo }) => Promise<void>,
): Promise<void> {
  const tmpDir = await mkdtempForTest(tempPrefix);
  const xcrunPath = path.join(tmpDir, 'xcrun');
  const argsLogPath = path.join(tmpDir, 'args.log');
  const scriptWithPrivacyHelp = injectDefaultPrivacyHelp(script);
  await fs.writeFile(xcrunPath, scriptWithPrivacyHelp, 'utf8');
  await fs.chmod(xcrunPath, 0o755);

  const previousPath = process.env.PATH;
  const previousArgsFile = process.env.AGENT_DEVICE_TEST_ARGS_FILE;
  process.env.PATH = `${tmpDir}${path.delimiter}${previousPath ?? ''}`;
  process.env.AGENT_DEVICE_TEST_ARGS_FILE = argsLogPath;

  try {
    await run({ tmpDir, argsLogPath, device: IOS_TEST_DEVICE });
  } finally {
    process.env.PATH = previousPath;
    if (previousArgsFile === undefined) {
      delete process.env.AGENT_DEVICE_TEST_ARGS_FILE;
    } else {
      process.env.AGENT_DEVICE_TEST_ARGS_FILE = previousArgsFile;
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

function injectDefaultPrivacyHelp(script: string): string {
  if (script.includes('AGENT_DEVICE_CUSTOM_PRIVACY_HELP')) return script;
  const helpBlock = `if [ "$1" = "simctl" ] && [ "$2" = "privacy" ] && [ "$3" = "help" ]; then
  cat <<'HELP'
Usage: simctl privacy <device> <action> <service> [<bundle identifier>]

        service
             The service:
                 all - Apply the action to all services.
                 calendar - Allow access to calendar.
                 contacts-limited - Allow access to basic contact info.
                 contacts - Allow access to full contact details.
                 location - Allow access to location services when app is in use.
                 location-always - Allow access to location services at all times.
                 photos-add - Allow adding photos to the photo library.
                 photos - Allow full access to the photo library.
                 media-library - Allow access to the media library.
                 microphone - Allow access to audio input.
                 motion - Allow access to motion and fitness data.
                 reminders - Allow access to reminders.
                 siri - Allow use of the app with Siri.
                 camera - Allow access to camera.
                 notifications - Allow access to notifications.
HELP
  exit 0
fi
`;
  const shebang = '#!/bin/sh\n';
  if (!script.startsWith(shebang)) return `${shebang}${helpBlock}${script}`;
  return `${shebang}${helpBlock}${script.slice(shebang.length)}`;
}
