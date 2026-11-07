import UIAbility from '@ohos.app.ability.UIAbility';
import type Want from '@ohos.app.ability.Want';
import { window } from '@kit.ArkUI';
import type { BusinessError } from '@kit.BasicServicesKit';

/**
 * Standard hypium host: boots the empty test page, which in turn starts the runner's cases.
 */
export default class TestAbility extends UIAbility {
  onCreate(_want: Want): void {}

  onDestroy(): void {}

  onWindowStageCreate(windowStage: window.WindowStage): void {
    windowStage.loadContent('testability/pages/Index', (error: BusinessError) => {
      if (error.code !== 0) {
        console.error(`testability loadContent failed: ${JSON.stringify(error)}`);
      }
    });
  }

  onWindowStageDestroy(): void {}

  onForeground(): void {}

  onBackground(): void {}
}
