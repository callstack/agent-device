package com.callstack.agentdevice.snapshothelper;

import android.app.UiAutomation;
import android.os.Bundle;
import android.os.ParcelFileDescriptor;
import android.os.SystemClock;
import android.view.accessibility.AccessibilityNodeInfo;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;

final class ApplicationCommandHandler {
  private ApplicationCommandHandler() {}

  static void execute(UiAutomation automation, JSONObject input, Bundle result) throws Exception {
    String packageName = input.getString("packageName");
    if (!packageName.matches("[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z][A-Za-z0-9_]*)+")) {
      throw new IllegalArgumentException("Invalid application package");
    }
    switch (input.getString("kind")) {
      case "stop":
        stop(automation, packageName, result);
        return;
      case "open":
        open(automation, packageName, result);
        return;
      default:
        throw new IllegalArgumentException("Unknown application operation");
    }
  }

  private static void stop(UiAutomation automation, String packageName, Bundle result) throws Exception {
    shell(automation, "am force-stop " + packageName);
    long deadline = SystemClock.uptimeMillis() + 2000;
    boolean background = false;
    while (SystemClock.uptimeMillis() < deadline) {
      AccessibilityTreeCapture.clearAccessibilityCache(automation);
      AccessibilityNodeInfo root = automation.getRootInActiveWindow();
      try {
        if (root != null && root.getPackageName() != null) result.putString("foregroundPackage", root.getPackageName().toString());
        if (root != null && root.getPackageName() != null && !packageName.contentEquals(root.getPackageName())) {
          background = true;
          break;
        }
      } finally {
        if (root != null) root.recycle();
      }
      Thread.sleep(50);
    }
    if (!background) {
      result.putString("closePhase", "foreground");
      return;
    }
    deadline = SystemClock.uptimeMillis() + 2000;
    while (SystemClock.uptimeMillis() < deadline) {
      if (processGone(automation, packageName)) {
        Thread.sleep(150);
        if (SystemClock.uptimeMillis() < deadline && processGone(automation, packageName)) {
          result.putString("stopped", "true");
          return;
        }
      }
      Thread.sleep(50);
    }
    result.putString("closePhase", "process");
  }

  private static boolean processGone(UiAutomation automation, String packageName) throws Exception {
    String output = shell(automation, "pidof " + packageName + " 2>&1; echo __agent_device_exit:$?").trim();
    return output.equals("__agent_device_exit:1") || output.equals("__agent_device_exit:0");
  }

  private static void open(UiAutomation automation, String packageName, Bundle result) throws Exception {
    String resolved = shell(automation, "cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.LAUNCHER " + packageName).trim();
    String[] lines = resolved.split("\\n");
    String component = lines[lines.length - 1].trim();
    if (!component.matches(java.util.regex.Pattern.quote(packageName) + "/[A-Za-z_.$][A-Za-z0-9_.$]*")) {
      result.putString("notInstalled", "true");
      return;
    }
    result.putString("launchOutput", shell(automation, "am start -W -n " + component));
  }

  private static String shell(UiAutomation automation, String command) throws Exception {
    ParcelFileDescriptor[] pipes = automation.executeShellCommandRw("sh");
    if (pipes == null || pipes.length != 2) throw new IllegalStateException("Application shell command was unavailable");
    try (InputStream stream = new ParcelFileDescriptor.AutoCloseInputStream(pipes[0]);
        OutputStream input = new ParcelFileDescriptor.AutoCloseOutputStream(pipes[1]);
        ByteArrayOutputStream bytes = new ByteArrayOutputStream()) {
      input.write(("exec 2>&1\n" + command + "\n").getBytes(StandardCharsets.UTF_8));
      input.close();
      byte[] buffer = new byte[4096];
      int count;
      while ((count = stream.read(buffer)) != -1) {
        if (bytes.size() + count > 65536) throw new IllegalStateException("Application command output exceeded its limit");
        bytes.write(buffer, 0, count);
      }
      return bytes.toString(StandardCharsets.UTF_8.name());
    }
  }
}
