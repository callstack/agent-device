package com.callstack.agentdevice.imehelper;

import android.Manifest;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.inputmethodservice.InputMethodService;
import android.os.Build;
import android.os.Bundle;
import android.util.Base64;
import android.util.Log;
import android.view.View;
import android.view.inputmethod.InputConnection;
import java.nio.charset.StandardCharsets;

/**
 * Minimal headless test IME for agent-device: renders no input view, injects text over a broadcast
 * channel gated by a broadcastPermission only adb shell / privileged callers hold. Treats every
 * broadcast extra as untrusted input.
 *
 * <p>Protocol {@code android-ime-helper-v2} answers every known action with an ordered result
 * ({@link BroadcastReceiver#goAsync()} + {@code setResult}), so `am broadcast` prints
 * `Broadcast completed: result=&lt;code&gt;, data="..."` and the host can tell an accepted, attempted
 * dispatch from a dropped one. Result codes are a finite set and result data carries lengths only,
 * never user text. {@code result=0} is reserved: it is what the transport prints when no receiver
 * answered, so a live receiver never reports it for a known action. An ack proves attempted dispatch
 * (and the {@code commitText} return), not final field content — editors may transform text.
 */
public class TestInputMethodService extends InputMethodService {
  private static final String TAG = "AgentDeviceTestIME";
  private static final String PROTOCOL = "android-ime-helper-v2";

  public static final String ACTION_PROBE =
      "com.callstack.agentdevice.imehelper.ACTION_PROBE";
  public static final String ACTION_INPUT_TEXT =
      "com.callstack.agentdevice.imehelper.ACTION_INPUT_TEXT";
  public static final String ACTION_INPUT_TEXT_B64 =
      "com.callstack.agentdevice.imehelper.ACTION_INPUT_TEXT_B64";
  public static final String ACTION_CLEAR_TEXT =
      "com.callstack.agentdevice.imehelper.ACTION_CLEAR_TEXT";
  public static final String EXTRA_TEXT = "text";
  public static final String EXTRA_PROTOCOL = "protocol";

  // Finite result-code set, all non-zero; 0 means "no receiver answered" at the transport.
  static final int RESULT_COMMITTED = 1; // commitText returned true: attempted dispatch
  static final int RESULT_COMMIT_RETURNED_FALSE = 2;
  static final int RESULT_NO_INPUT_CONNECTION = 3;
  static final int RESULT_REJECTED_PAYLOAD = 4; // too large / malformed / unknown action
  static final int RESULT_PROTOCOL_MISMATCH = 5;
  static final int RESULT_PROBE_OK = 100;

  // Senders must hold this to reach the receiver. adb shell (uid 2000) holds it — a co-installed
  // third-party app cannot be granted a signature|privileged permission, so it cannot inject text.
  private static final String REQUIRED_SENDER_PERMISSION = Manifest.permission.WRITE_SECURE_SETTINGS;

  // Declared upper bound on a single broadcast payload: 64_000 base64 chars decode to at most
  // 48_000 UTF-8 bytes. Measured on-device (Pixel 7, API 36): payloads up to 64_000 chars are
  // delivered and committed; the adb-shell channel itself breaks ("error: closed") between
  // 65_000 and 66_000 chars, so this declared bound is the binding per-dispatch limit and the
  // host chunks below it. Never truncate to fit: over-cap payloads are rejected with a result code.
  private static final int MAX_BASE64_LENGTH = 64_000;
  private static final int MAX_TEXT_BYTES = MAX_BASE64_LENGTH / 4 * 3;

  private BroadcastReceiver receiver;

  @Override
  public void onCreate() {
    super.onCreate();
    receiver =
        new BroadcastReceiver() {
          @Override
          public void onReceive(Context context, Intent intent) {
            // Keep editor access on the receiver's main thread, where the IME owns its connection.
            final BroadcastReceiver.PendingResult pending = goAsync();
            try {
              handleAction(intent, pending);
            } catch (RuntimeException error) {
              Log.w(TAG, "handleAction failed: " + error.getClass().getSimpleName());
              pending.setResult(RESULT_REJECTED_PAYLOAD, "error", null);
            } finally {
              pending.finish();
            }
          }
        };
    IntentFilter filter = new IntentFilter();
    filter.addAction(ACTION_PROBE);
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

  private void handleAction(Intent intent, BroadcastReceiver.PendingResult pending) {
    String action = intent.getAction();
    if (action == null) {
      pending.setResult(RESULT_REJECTED_PAYLOAD, "no-action", null);
      return;
    }
    if (ACTION_PROBE.equals(action)) {
      if (!isProtocolAcceptable(intent)) {
        pending.setResult(RESULT_PROTOCOL_MISMATCH, "protocol", null);
        Log.w(TAG, "probe: protocol mismatch");
        return;
      }
      Bundle extras = new Bundle();
      extras.putString("protocol", PROTOCOL);
      extras.putInt("maxBase64Length", MAX_BASE64_LENGTH);
      pending.setResult(RESULT_PROBE_OK, PROTOCOL, extras);
      Log.i(TAG, "probe ok code=" + RESULT_PROBE_OK);
      return;
    }
    if (!isKnownAction(action)) {
      pending.setResult(RESULT_REJECTED_PAYLOAD, "unknown-action", null);
      Log.w(TAG, "handleAction: unknown action");
      return;
    }
    if (!isProtocolAcceptable(intent)) {
      pending.setResult(RESULT_PROTOCOL_MISMATCH, "protocol", null);
      Log.w(TAG, "handleAction: rejected " + action + ", protocol mismatch");
      return;
    }

    if (ACTION_CLEAR_TEXT.equals(action)) {
      InputConnection clearIc = getCurrentInputConnection();
      if (clearIc == null) {
        pending.setResult(RESULT_NO_INPUT_CONNECTION, "no-input-connection", null);
        Log.w(TAG, "clearText: no current input connection");
        return;
      }
      int code = clearText(clearIc) ? RESULT_COMMITTED : RESULT_COMMIT_RETURNED_FALSE;
      pending.setResult(code, "utf16=0", null);
      Log.i(TAG, "clearText code=" + code);
      return;
    }

    String text;
    if (ACTION_INPUT_TEXT.equals(action)) {
      text = intent.getStringExtra(EXTRA_TEXT);
      if (text == null) {
        pending.setResult(RESULT_REJECTED_PAYLOAD, "empty", null);
        Log.w(TAG, "handleAction: empty payload");
        return;
      }
      if (text.length() > MAX_TEXT_BYTES
          || text.getBytes(StandardCharsets.UTF_8).length > MAX_TEXT_BYTES) {
        pending.setResult(RESULT_REJECTED_PAYLOAD, "too-large", null);
        Log.w(TAG, "handleAction: text payload too large, rejected utf16=" + text.length());
        return;
      }
    } else {
      text = decodeBase64Text(intent.getStringExtra(EXTRA_TEXT), pending);
      if (text == null) return; // rejection already reported with a result code
    }

    InputConnection ic = getCurrentInputConnection();
    if (ic == null) {
      pending.setResult(RESULT_NO_INPUT_CONNECTION, "no-input-connection", null);
      Log.w(TAG, "handleAction: no current input connection for " + action);
      return;
    }
    // No truncation: the host chunks within the declared byte bound; anything larger was already
    // rejected above, so a length mismatch here is a bug, not something to paper over.
    boolean commitReturn = ic.commitText(text, 1);
    int code = commitReturn ? RESULT_COMMITTED : RESULT_COMMIT_RETURNED_FALSE;
    pending.setResult(code, "utf16=" + text.length(), null);
    Log.i(TAG, "commitText code=" + code + " length=" + text.length());
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

  /** @return decoded text, or null after reporting a rejection result code. */
  private static String decodeBase64Text(String encoded, BroadcastReceiver.PendingResult pending) {
    if (encoded == null || encoded.isEmpty()) {
      pending.setResult(RESULT_REJECTED_PAYLOAD, "empty", null);
      Log.w(TAG, "decodeBase64Text: empty payload");
      return null;
    }
    if (encoded.length() > MAX_BASE64_LENGTH) {
      pending.setResult(RESULT_REJECTED_PAYLOAD, "too-large", null);
      Log.w(TAG, "decodeBase64Text: payload too large, rejected b64Len=" + encoded.length());
      return null;
    }
    try {
      byte[] decoded = Base64.decode(encoded, Base64.DEFAULT);
      return new String(decoded, StandardCharsets.UTF_8);
    } catch (IllegalArgumentException error) {
      pending.setResult(RESULT_REJECTED_PAYLOAD, "bad-base64", null);
      Log.w(TAG, "decodeBase64Text: malformed base64 payload", error);
      return null;
    }
  }

  private boolean clearText(InputConnection ic) {
    ic.beginBatchEdit();
    try {
      ic.performContextMenuAction(android.R.id.selectAll);
      return ic.commitText("", 1);
    } finally {
      ic.endBatchEdit();
    }
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
