package com.callstack.agentdevice.snapshothelper;

import android.content.res.Configuration;
import android.os.LocaleList;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;

/**
 * Sets the system locale list. It runs through {@code app_process} as the shell user, which holds
 * CHANGE_CONFIGURATION and WRITE_SETTINGS; no installed app can hold the first. This is the same
 * persistent configuration update the Settings language picker makes, so it survives a reboot and
 * running apps receive a configuration change.
 *
 * <p>Usage: {@code app_process /system/bin <this class> <language tags>}. It prints {@code
 * previous=<tags>} and {@code current=<tags>}, or {@code error=<message>} and exits 1.
 */
public final class SystemLocaleCommand {
  private SystemLocaleCommand() {}

  public static void main(String[] args) {
    try {
      if (args.length != 1 || args[0].isEmpty()) {
        throw new IllegalArgumentException("Pass one comma-separated list of language tags");
      }
      LocaleList requested = LocaleList.forLanguageTags(args[0]);
      Object activityManager =
          Class.forName("android.app.ActivityManager").getMethod("getService").invoke(null);
      Class<?> service = Class.forName("android.app.IActivityManager");
      Method getConfiguration = service.getMethod("getConfiguration");
      Configuration previous = (Configuration) getConfiguration.invoke(activityManager);
      Configuration update = new Configuration();
      update.setLocales(requested);
      Configuration.class.getField("userSetLocale").setBoolean(update, true);
      service
          .getMethod("updatePersistentConfiguration", Configuration.class)
          .invoke(activityManager, update);
      Configuration current = (Configuration) getConfiguration.invoke(activityManager);
      System.out.println("previous=" + previous.getLocales().toLanguageTags());
      System.out.println("current=" + current.getLocales().toLanguageTags());
    } catch (Throwable error) {
      Throwable cause = error instanceof InvocationTargetException ? error.getCause() : error;
      System.out.println("error=" + cause);
      System.exit(1);
    }
  }
}
