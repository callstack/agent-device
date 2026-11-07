import UIAbility from '@ohos.app.ability.UIAbility';
import type Want from '@ohos.app.ability.Want';
import { window } from '@kit.ArkUI';
import type { BusinessError } from '@kit.BasicServicesKit';

/**
 * The installable home of the carrier HAP. The injection itself lives in the ohosTest module
 * (the SDK restricts the UiTest APIs to testing directories), so this ability carries no logic.
 */
export default class EntryAbility extends UIAbility {
  onCreate(_want: Want): void {}

  onDestroy(): void {}

  onWindowStageCreate(windowStage: window.WindowStage): void {
    windowStage.loadContent('pages/Index', (error: BusinessError) => {
      if (error.code !== 0) {
        console.error(`loadContent failed: ${JSON.stringify(error)}`);
      }
    });
  }

  onWindowStageDestroy(): void {}

  onForeground(): void {}

  onBackground(): void {}
}
