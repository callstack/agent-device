package com.callstack.agentdevice.imehelper;

import android.Manifest;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.inputmethodservice.InputMethodService;
import android.os.Build;
import android.util.Base64;
import android.util.Log;
import android.view.View;
import android.view.inputmethod.InputConnection;
import java.nio.charset.StandardCharsets;

/**
 * Minimal headless test IME for agent-device: renders no input view, injects text over a broadcast
 * channel gated by a broadcastPermission only adb shell / privileged callers hold. Treats every
 * broadcast extra as untrusted input.
 */
public class TestInputMethodService extends InputMethodService {
  private static final String TAG = "AgentDeviceTestIME";
  private static final String PROTOCOL = "android-ime-helper-v1";

  public static final String ACTION_INPUT_TEXT =
      "com.callstack.agentdevice.imehelper.ACTION_INPUT_TEXT";
  public static final String ACTION_INPUT_TEXT_B64 =
      "com.callstack.agentdevice.imehelper.ACTION_INPUT_TEXT_B64";
  public static final String ACTION_CLEAR_TEXT =
      "com.callstack.agentdevice.imehelper.ACTION_CLEAR_TEXT";
  public static final String EXTRA_TEXT = "text";
  public static final String EXTRA_PROTOCOL = "protocol";

  // Senders must hold this to reach the receiver. adb shell (uid 2000) holds it — a co-installed
  // third-party app cannot be granted a signature|privileged permission, so it cannot inject text.
  private static final String REQUIRED_SENDER_PERMISSION = Manifest.permission.WRITE_SECURE_SETTINGS;

  // Upper bound on a single broadcast payload.
  private static final int MAX_TEXT_LENGTH = 32_000;

  private BroadcastReceiver receiver;

  @Override
  public void onCreate() {
    super.onCreate();
    receiver =
        new BroadcastReceiver() {
          @Override
          public void onReceive(Context context, Intent intent) {
            try {
              handleAction(intent);
            } catch (Throwable error) {
              // Never let untrusted extras crash the IME process.
              Log.w(TAG, "handleAction failed for " + intent.getAction(), error);
            }
          }
        };
    IntentFilter filter = new IntentFilter();
    filter.addAction(ACTION_INPUT_TEXT);
    filter.addAction(ACTION_INPUT_TEXT_B64);
    filter.addAction(ACTION_CLEAR_TEXT);
    // Register the receiver in the running IME process (so getCurrentInputConnection() is live)
    // but require REQUIRED_SENDER_PERMISSION of every sender. On API 33+ the receiver must also be
    // flagged exported to accept out-of-app broadcasts; the permission is the actual trust gate.
    if (Build.VERSION.SDK_INT >= 33) {
      // exported: shell cannot deliver explicit broadcasts to non-exported components on API 36+;
      // do not switch to RECEIVER_NOT_EXPORTED — WRITE_SECURE_SETTINGS is what keeps other apps out.
      registerReceiver(
          receiver, filter, REQUIRED_SENDER_PERMISSION, null, Context.RECEIVER_EXPORTED);
    } else {
      registerReceiver(receiver, filter, REQUIRED_SENDER_PERMISSION, null);
    }
    Log.i(TAG, "onCreate: permission-gated receiver registered");
  }

  @Override
  public void onDestroy() {
    if (receiver != null) {
      unregisterReceiver(receiver);
      receiver = null;
    }
    super.onDestroy();
  }

  private void handleAction(Intent intent) {
    String action = intent.getAction();
    if (action == null) return;
    if (!isKnownAction(action)) return;
    if (!isProtocolAcceptable(intent)) {
      Log.w(TAG, "handleAction: rejected " + action + ", protocol mismatch");
      return;
    }

    InputConnection ic = getCurrentInputConnection();
    if (ic == null) {
      Log.w(TAG, "handleAction: no current input connection for " + action);
      return;
    }

    if (ACTION_INPUT_TEXT.equals(action)) {
      commitValidatedText(ic, intent.getStringExtra(EXTRA_TEXT));
    } else if (ACTION_INPUT_TEXT_B64.equals(action)) {
      commitValidatedText(ic, decodeBase64Text(intent.getStringExtra(EXTRA_TEXT)));
    } else if (ACTION_CLEAR_TEXT.equals(action)) {
      clearText(ic);
    }
  }

  private static boolean isKnownAction(String action) {
    return ACTION_INPUT_TEXT.equals(action)
        || ACTION_INPUT_TEXT_B64.equals(action)
        || ACTION_CLEAR_TEXT.equals(action);
  }

  // Optional sanity check, not a security boundary; missing extra is accepted.
  private static boolean isProtocolAcceptable(Intent intent) {
    if (!intent.hasExtra(EXTRA_PROTOCOL)) return true;
    return PROTOCOL.equals(intent.getStringExtra(EXTRA_PROTOCOL));
  }

  private static String decodeBase64Text(String encoded) {
    if (encoded == null || encoded.isEmpty()) return null;
    if (encoded.length() > MAX_TEXT_LENGTH * 2) {
      Log.w(TAG, "decodeBase64Text: payload too large, dropping");
      return null;
    }
    try {
      byte[] decoded = Base64.decode(encoded, Base64.DEFAULT);
      return new String(decoded, StandardCharsets.UTF_8);
    } catch (IllegalArgumentException error) {
      Log.w(TAG, "decodeBase64Text: malformed base64 payload", error);
      return null;
    }
  }

  private void commitValidatedText(InputConnection ic, String text) {
    if (text == null) return;
    String bounded = text.length() > MAX_TEXT_LENGTH ? text.substring(0, MAX_TEXT_LENGTH) : text;
    ic.commitText(bounded, 1);
    Log.i(TAG, "commitText length=" + bounded.length());
  }

  private void clearText(InputConnection ic) {
    ic.beginBatchEdit();
    ic.performContextMenuAction(android.R.id.selectAll);
    ic.commitText("", 1);
    ic.endBatchEdit();
    Log.i(TAG, "clearText");
  }

  @Override
  public boolean onEvaluateInputViewShown() {
    return false;
  }

  @Override
  public boolean onEvaluateFullscreenMode() {
    return false;
  }

  @Override
  public View onCreateInputView() {
    return null;
  }
}
