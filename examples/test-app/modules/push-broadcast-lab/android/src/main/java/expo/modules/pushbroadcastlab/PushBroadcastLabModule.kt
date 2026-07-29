package expo.modules.pushbroadcastlab

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class PushBroadcastLabModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("PushBroadcastLab")

    Function("lastPushBroadcast") {
      appContext.reactContext
        ?.getSharedPreferences(PushBroadcastReceiver.PREFERENCES, 0)
        ?.getString(PushBroadcastReceiver.LAST_BROADCAST, null)
        ?: "none"
    }
  }
}
