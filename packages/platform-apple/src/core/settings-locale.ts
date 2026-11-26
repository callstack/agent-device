import { parseLocaleId } from '@agent-device/contracts/settings';
import { SETTING_RESET_STATE } from '@agent-device/contracts/settings-catalog';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { requireExecSuccess } from '@agent-device/host-kit/command';
import { runSimctlForDevice } from './simctl-execution.ts';

/**
 * Applies a BCP 47 tag the settings contract already parsed, or `reset`. The language and region
 * live in the simulator's global preferences domain, which every app reads at launch. `simctl spawn`
 * runs `defaults` inside the simulator, so the write goes through the simulator's own preferences
 * daemon rather than a plist a running daemon would overwrite.
 */
export async function setIosLocale(
  device: DeviceInfo,
  state: string,
): Promise<Record<string, unknown>> {
  const locale = state === SETTING_RESET_STATE ? undefined : state;
  const previous = await readLocaleDefaults(device);
  if (locale === undefined) {
    // Only the keys the domain holds: deleting an absent key fails, and reset already holds there.
    for (const key of previous.keys) await runDefaults(device, ['delete', '-g', key]);
  } else {
    await runDefaults(device, ['write', '-g', 'AppleLanguages', '-array', locale]);
    await runDefaults(device, [
      'write',
      '-g',
      'AppleLocale',
      '-string',
      appleLocaleIdentifier(locale),
    ]);
  }
  return {
    locale: locale ?? null,
    previousLocale: previous.locale,
    previousLanguages: previous.languages,
    warnings: ['Running apps keep the old locale until they relaunch; run open <app> --relaunch.'],
  };
}

/** `en-IN` is `en_IN` to Foundation; a script stays joined to the language, as in `zh-Hans_CN`. */
function appleLocaleIdentifier(languageTag: string): string {
  const parts = languageTag.split('-');
  const region = parts.at(-1);
  if (parts.length < 2 || region === undefined || !/^([A-Z]{2}|\d{3})$/.test(region)) {
    return languageTag;
  }
  return `${parts.slice(0, -1).join('-')}_${region}`;
}

/**
 * The locale keys the global domain holds. `defaults export` answers with the whole domain as an XML
 * plist, so an absent key is just absent rather than a failure whose wording varies by runtime.
 * The locale is reported as a tag `settings locale` accepts, so a reset can be undone with it:
 * Foundation keeps keywords such as `@rg=inzzzz` that the command does not take, and the full
 * list of preferred languages is reported beside it.
 */
async function readLocaleDefaults(device: DeviceInfo): Promise<{
  locale: string | null;
  languages: readonly string[] | null;
  keys: readonly string[];
}> {
  const { stdout } = await runSimctlChecked(
    device,
    ['defaults', 'export', '-g', '-'],
    'Failed to read the iOS simulator locale',
  );
  const keys = LOCALE_KEYS.filter((key) => stdout.includes(`<key>${key}</key>`));
  const appleLocale = /<key>AppleLocale<\/key>\s*<string>([^<]*)<\/string>/.exec(stdout)?.[1];
  const languages = /<key>AppleLanguages<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(stdout)?.[1];
  return {
    locale: appleLocale === undefined ? null : acceptedLocale(appleLocale.split('@')[0] ?? ''),
    languages:
      languages === undefined
        ? null
        : [...languages.matchAll(/<string>([^<]*)<\/string>/g)].map((match) => match[1] ?? ''),
    keys,
  };
}

function acceptedLocale(appleLocale: string): string | null {
  try {
    return parseLocaleId(appleLocale);
  } catch {
    return null;
  }
}

const LOCALE_KEYS = ['AppleLanguages', 'AppleLocale'] as const;

async function runDefaults(device: DeviceInfo, args: readonly string[]): Promise<void> {
  await runSimctlChecked(device, ['defaults', ...args], 'Failed to set the iOS simulator locale');
}

async function runSimctlChecked(device: DeviceInfo, args: readonly string[], message: string) {
  return requireExecSuccess(
    await runSimctlForDevice(device, ['spawn', device.id, ...args], { allowFailure: true }),
    message,
  );
}
