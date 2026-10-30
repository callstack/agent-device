import { expectTypeOf, test } from 'vitest';
import type { AppleRunnerHost } from '@agent-device/apple-runner';
import type {
  runAppleToolCommand,
  runXcrun,
  readApplePlistJson,
  hasScopedAppleToolProvider,
} from '../tool-provider.ts';
import type { buildSimctlArgsForDevice, simulatorAddressFor } from '../simctl.ts';

test('the runner tool port matches the Apple capability signatures', () => {
  expectTypeOf<AppleRunnerHost['runAppleToolCommand']>().toEqualTypeOf<
    typeof runAppleToolCommand
  >();
  expectTypeOf<Parameters<AppleRunnerHost['runXcrun']>[0]>().toEqualTypeOf<
    Extract<Parameters<typeof runXcrun>[0], Parameters<AppleRunnerHost['runXcrun']>[0]>
  >();
  expectTypeOf<ReturnType<AppleRunnerHost['runXcrun']>>().toEqualTypeOf<
    ReturnType<typeof runXcrun>
  >();
  expectTypeOf<AppleRunnerHost['readApplePlistJson']>().toEqualTypeOf<typeof readApplePlistJson>();
  expectTypeOf<AppleRunnerHost['hasScopedAppleToolProvider']>().toEqualTypeOf<
    typeof hasScopedAppleToolProvider
  >();
  expectTypeOf<AppleRunnerHost['buildSimctlArgsForDevice']>().toEqualTypeOf<
    typeof buildSimctlArgsForDevice
  >();
  expectTypeOf<Parameters<AppleRunnerHost['simulatorAddressFor']>>().toEqualTypeOf<
    Parameters<typeof simulatorAddressFor>
  >();
  expectTypeOf<ReturnType<AppleRunnerHost['simulatorAddressFor']>>().toEqualTypeOf<
    Pick<ReturnType<typeof simulatorAddressFor>, 'udid' | 'simulatorSetPath'>
  >();
});
