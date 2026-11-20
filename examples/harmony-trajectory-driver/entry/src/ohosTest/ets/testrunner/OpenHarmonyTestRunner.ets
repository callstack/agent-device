import type TestRunner from '@ohos.application.testRunner';
import abilityDelegatorRegistry from '@ohos.app.ability.abilityDelegatorRegistry';
import { Hypium } from '@ohos/hypium';
import testsuite from '../test/List.test.ets';
import type Want from '@ohos.app.ability.Want';

/**
 * Standard runner: the framework instantiates this class and drives the lifecycle. `onRun` boots
 * the test ability (the uitest IPC server side publishes from a live ability context), then
 * starts hypium; the `-s` key/values (traj) ride AbilityDelegatorArguments into cases.
 */
export default class OpenHarmonyTestRunner implements TestRunner {
  onPrepare(): void {
    console.info('OpenHarmonyTestRunner onPrepare');
  }

  async onRun(): Promise<void> {
    console.info('OpenHarmonyTestRunner onRun begin');
    const abilityDelegator = abilityDelegatorRegistry.getAbilityDelegator();
    const abilityDelegatorArguments = abilityDelegatorRegistry.getArguments();
    const want: Want = {
      bundleName: 'com.stringzhao.adtrajdriver',
      abilityName: 'TestAbility',
    };
    try {
      await abilityDelegator.startAbility(want);
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 1000);
      });
    } catch (error) {
      console.error(`startAbility TestAbility failed: ${(error as Error).message}`);
    }
    Hypium.hypiumTest(abilityDelegator, abilityDelegatorArguments, testsuite);
    console.info('OpenHarmonyTestRunner onRun end');
  }

  onStop = (): void => {
    console.info('OpenHarmonyTestRunner onStop');
  };
}
