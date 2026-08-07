import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import type { AppleToolProvider } from '../../platforms/apple/core/tool-provider.ts';
import { withAppleToolProvider } from '../../platforms/apple/core/tool-provider.ts';
import { execFailureDetails, type ExecResult } from '../../utils/exec.ts';
import { IOS_DEVICE } from './device-fixtures.ts';

/**
 * A scripted response for one fake Apple tool invocation: a string is
 * shorthand for that stdout with exit 0, a partial result overrides the
 * success defaults, an Error simulates a transport-level failure, and
 * `undefined` falls back to empty success (the PATH-stub scripts' `exit 0`
 * default).
 */
export type FakeAppleToolResponse = string | Partial<ExecResult> | Error;

/**
 * Receives the flat invocation the PATH-stub xcrun scripts saw: for
 * `simctl`/`devicectl` calls the tool word is prepended
 * (`['simctl', 'privacy', ...]`), for other `runCommand` binaries the command
 * name leads (`['open', ...]`).
 */
export type FakeAppleToolScript = (args: string[]) => FakeAppleToolResponse | undefined;

/**
 * The `simctl privacy help` service listing production probes to enumerate
 * privacy services — the same canned block `withMockedXcrun` injected into
 * every PATH-stub script. Served when the test's script returns `undefined`
 * for that probe, so scripts only model it to override it.
 */
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
                 camera - Allow access to camera.
                 notifications - Allow access to notifications.`;

/**
 * Runs `run` with a scripted in-process Apple tool provider installed through
 * the production {@link withAppleToolProvider} scope — the seam the daemon
 * installs per request and the provider-scenario lane exercises. Prefer this
 * over PATH-stub xcrun scripts (`withMockedXcrun`): no PATH mutation, no
 * spawns, no real subprocess waits.
 *
 * Mirrors the local provider's contract: a scripted nonzero exit throws the
 * production-shaped COMMAND_FAILED (`<cmd> exited with code N` with
 * `execFailureDetails`) unless the call site passed `allowFailure` — the same
 * path a PATH-stub `exit 1` took through exec.ts.
 */
export async function withFakeAppleTool<T>(
  script: FakeAppleToolScript,
  run: (ctx: { calls: string[][]; device: DeviceInfo }) => Promise<T>,
  options: {
    device?: DeviceInfo;
    /**
     * Extra provider members (plist, macosHelper, macosHost, ...) merged into
     * the installed fake. The scripted executors always win for
     * runCommand/simctl/devicectl so `calls` keeps recording.
     */
    provider?: Partial<AppleToolProvider>;
  } = {},
): Promise<T> {
  // Fresh copy per call: tests may tailor the device without leaking
  // mutations into the shared fixture.
  const device: DeviceInfo = { ...(options.device ?? IOS_DEVICE) };
  const calls: string[][] = [];

  const respond = async (
    flat: string[],
    executable: string,
    allowFailure: boolean | undefined,
  ): Promise<ExecResult> => {
    calls.push([...flat]);
    let response = script(flat);
    if (response === undefined && flat[0] === 'simctl' && flat[1] === 'privacy') {
      const probesHelp = flat.includes('help');
      if (probesHelp) response = SIMCTL_PRIVACY_HELP;
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
