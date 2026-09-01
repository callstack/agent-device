import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import type { AppleToolProvider } from '../core/tool-provider.ts';
import { withAppleToolProvider } from '../core/tool-provider.ts';
import { execFailureDetails, type ExecResult } from '@agent-device/host-kit/command';
import { IOS_DEVICE } from './device-fixtures.ts';

export type FakeAppleToolResponse = string | Partial<ExecResult> | Error;
export type FakeAppleToolScript = (args: string[]) => FakeAppleToolResponse | undefined;

const SIMCTL_PRIVACY_HELP = `Usage: simctl privacy <device> <action> <service> [<bundle identifier>]

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
                 camera - Allow access to the camera.
                 notifications - Allow access to notifications.`;

export async function withFakeAppleTool<T>(
  script: FakeAppleToolScript,
  run: (ctx: { calls: string[][]; device: DeviceInfo }) => Promise<T>,
  options: { device?: DeviceInfo; provider?: Partial<AppleToolProvider> } = {},
): Promise<T> {
  const device: DeviceInfo = { ...(options.device ?? IOS_DEVICE) };
  const calls: string[][] = [];

  const respond = async (
    flat: string[],
    executable: string,
    allowFailure: boolean | undefined,
  ): Promise<ExecResult> => {
    calls.push([...flat]);
    let response = script(flat);
    if (
      response === undefined &&
      flat[0] === 'simctl' &&
      flat[1] === 'privacy' &&
      flat.includes('help')
    ) {
      response = SIMCTL_PRIVACY_HELP;
    }
    if (response instanceof Error) throw response;
    const result: ExecResult =
      typeof response === 'string'
        ? { stdout: response, stderr: '', exitCode: 0 }
        : { stdout: '', stderr: '', exitCode: 0, ...response };
    if (result.exitCode !== 0 && !allowFailure) {
      throw new AppError(
        'COMMAND_FAILED',
        `${executable} exited with code ${result.exitCode}`,
        execFailureDetails(result, { cmd: executable, args: flat }),
      );
    }
    return result;
  };

  const provider: AppleToolProvider = {
    ...options.provider,
    whichCommand: options.provider?.whichCommand ?? (async () => true),
    runCommand: async (cmd, args, execOptions) =>
      await respond(cmd === 'xcrun' ? [...args] : [cmd, ...args], cmd, execOptions?.allowFailure),
    simctl: {
      run: async (args, execOptions) =>
        await respond(['simctl', ...args], 'xcrun', execOptions?.allowFailure),
    },
    devicectl: {
      run: async (args, execOptions) =>
        await respond(['devicectl', ...args], 'xcrun', execOptions?.allowFailure),
    },
  };

  return await withAppleToolProvider(provider, async () => await run({ calls, device }));
}
