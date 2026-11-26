import { settingsRuntimeOperationFacts } from '@agent-device/contracts/settings-runtime';
import type { AndroidSetting } from '@agent-device/platform-android/mechanics';
import type { PlatformRuntimeOperations } from '@agent-device/contracts/platform-runtime-operations';
import {
  type RuntimeFacts,
  type RuntimeOperationFact,
  type RuntimeOperationUnavailability,
  unavailableFact,
  PLATFORM_RUNTIME_REASONS,
} from '@agent-device/contracts/platform-runtime';
const available = Object.freeze({ available: true } as const);
const unsupported = unavailableFact(PLATFORM_RUNTIME_REASONS.unsupportedProviderMode.reason);
const settingUnavailableAndroid = unavailableFact(
  PLATFORM_RUNTIME_REASONS.unsupportedPlatformLeaf.reason,
  'Run `agent-device settings --help` for the settings each target serves.',
);
export const LIMRUN_FOLD_UNAVAILABLE = unavailableFact(
  PLATFORM_RUNTIME_REASONS.unsupportedProviderMode.reason,
  'Limrun exposes the commanded hinge angle, but fold requires an independently observed angle to verify the pose.',
);
export const LIMRUN_TELEPHONY_UNAVAILABLE = unavailableFact(
  PLATFORM_RUNTIME_REASONS.unsupportedProviderMode.reason,
  "telephony sends calls and SMS to an Android emulator's console through local adb; agent-device does not route it through a Limrun session.",
);

export function limrunAndroidSettingsFacts(
  liveSessionUnavailable?: RuntimeOperationUnavailability,
) {
  return settingsRuntimeOperationFacts({
    target: liveSessionUnavailable ?? available,
    unsupported: settingUnavailableAndroid,
    write: {
      wifi: available,
      bluetooth: available,
      airplane: available,
      'mobile-data': available,
      'keep-awake': available,
      location: available,
      animations: available,
      appearance: available,
      'text-size': available,
      fingerprint: available,
      'clear-app-state': available,
      permission: available,
    } satisfies Record<AndroidSetting, RuntimeOperationFact>,
    read: { 'text-size': available },
  });
}

export function limrunAppleSettingsFacts(
  facts: Partial<RuntimeFacts<PlatformRuntimeOperations>['operations']>,
) {
  const setting = facts.setSetting;
  return {
    readSetting: facts.readSetting ?? unsupported,
    setSetting: setting?.available
      ? {
          ...setting,
          subjects: {
            ...setting.subjects,
            'reset-keychain': unavailableFact(
              PLATFORM_RUNTIME_REASONS.unsupportedProviderMode.reason,
              'Limrun does not expose keychain reset.',
            ),
          },
        }
      : (setting ?? unsupported),
  };
}
