package expo.modules.pushbroadcastlab

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

class PushBroadcastReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val source = intent.getStringExtra("source") ?: "none"
    val count = intent.getIntExtra("count", 0)
    context
      .getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
      .edit()
      .putString(LAST_BROADCAST, "source=$source,count=$count")
      .apply()
  }

  companion object {
    const val LAST_BROADCAST = "last_broadcast"
    const val PREFERENCES = "agent_device_push_broadcast_lab"
  }
}
