package com.callstack.agentdevice.snapshothelper;

import android.app.UiAutomation;
import android.os.Bundle;
import android.util.Base64;
import android.os.ParcelFileDescriptor;
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
      case "open":
        open(automation, packageName, result);
        return;
      default:
        throw new IllegalArgumentException("Unknown application operation");
    }
  }

  private static void open(UiAutomation automation, String packageName, Bundle result) throws Exception {
    String resolved = shell(automation, "cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.LAUNCHER " + packageName).trim();
    String[] lines = resolved.split("\\n");
    String component = lines[lines.length - 1].trim();
    if (!component.matches(java.util.regex.Pattern.quote(packageName) + "/[A-Za-z_.$][A-Za-z0-9_.$]*")) {
      result.putString("componentUnavailable", "true");
      return;
    }
    String output = shell(automation, "am start -W -a android.intent.action.MAIN -c android.intent.category.DEFAULT -c android.intent.category.LAUNCHER -n '" + component + "'");
    result.putString("launchOutputBase64", Base64.encodeToString(output.getBytes(StandardCharsets.UTF_8), Base64.NO_WRAP));
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
