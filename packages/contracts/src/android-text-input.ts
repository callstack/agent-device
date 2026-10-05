/**
 * The typed reason the Android adb-shell text channel reports when it cannot carry the
 * requested text. Recovery and hint rewriting key on this constant, never on the message:
 * the message states the channel limit, the reason names which recovery surfaces apply.
 */
export const ANDROID_SHELL_TEXT_UNSUPPORTED_REASON = 'android_shell_text_unsupported' as const;

/**
 * Recovery hint for direct-interaction callers (`open`, then a failing `fill`/`press`).
 * Replay and test runs replace it with {@link ANDROID_TEST_IME_FLOW_HINT} at the replay
 * failure boundary; `--test-ime` on `open` is not a surface a flow caller can use.
 */
export const ANDROID_TEST_IME_OPEN_HINT =
  'On emulators the test IME activates automatically; on real devices pass `open --test-ime` to enable it (see `agent-device doctor` for the current IME state).';

/**
 * Recovery hint for flow-owned session opens: `replay`/`test` accept `--test-ime`
 * themselves and pass the opt-in to the sessions their flow opens.
 */
export const ANDROID_TEST_IME_FLOW_HINT =
  'On emulators the test IME activates automatically; on real devices pass `--test-ime` to this test/replay run to enable it for the sessions the flow opens (see `agent-device doctor` for the current IME state).';
