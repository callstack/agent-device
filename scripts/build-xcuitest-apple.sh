#!/bin/sh
set -eu

PLATFORM="${AGENT_DEVICE_XCUITEST_PLATFORM:-}"
PROJECT_PATH="ios-runner/AgentDeviceRunner/AgentDeviceRunner.xcodeproj"
SCHEME="AgentDeviceRunner"
DEFAULT_IOS_RUNNER_APP_BUNDLE_ID="com.callstack.agentdevice.runner"

if [ -z "$PLATFORM" ]; then
  echo "AGENT_DEVICE_XCUITEST_PLATFORM is required (ios, macos, tvos)" >&2
  exit 1
fi

is_truthy() {
  case "${1:-}" in
    1|true|TRUE|yes|YES|on|ON)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

resolve_default_destination() {
  case "$PLATFORM" in
    ios)
      printf '%s\n' 'generic/platform=iOS Simulator'
      ;;
    macos)
      printf 'platform=macOS,arch=%s\n' "$(uname -m)"
      ;;
    tvos)
      printf '%s\n' 'generic/platform=tvOS Simulator'
      ;;
    *)
      echo "Unsupported AGENT_DEVICE_XCUITEST_PLATFORM: $PLATFORM" >&2
      exit 1
      ;;
  esac
}

resolve_default_derived_path() {
  case "$PLATFORM" in
    ios)
      printf '%s\n' "$HOME/.agent-device/ios-runner/derived"
      ;;
    macos)
      printf '%s\n' "$HOME/.agent-device/ios-runner/derived/macos"
      ;;
    tvos)
      printf '%s\n' "$HOME/.agent-device/ios-runner/derived/tvos"
      ;;
    *)
      echo "Unsupported AGENT_DEVICE_XCUITEST_PLATFORM: $PLATFORM" >&2
      exit 1
      ;;
  esac
}

resolve_clean_path() {
  if [ -n "${AGENT_DEVICE_IOS_RUNNER_DERIVED_PATH:-}" ]; then
    printf '%s\n' "$DERIVED_PATH"
    return
  fi

  case "$PLATFORM" in
    ios)
      printf '%s\n' "$DERIVED_PATH/device"
      ;;
    macos|tvos)
      printf '%s\n' "$DERIVED_PATH"
      ;;
    *)
      echo "Unsupported AGENT_DEVICE_XCUITEST_PLATFORM: $PLATFORM" >&2
      exit 1
      ;;
  esac
}

DESTINATION="${AGENT_DEVICE_XCUITEST_DESTINATION:-$(resolve_default_destination)}"
DERIVED_PATH="${AGENT_DEVICE_IOS_RUNNER_DERIVED_PATH:-$(resolve_default_derived_path)}"
CLEAN_PATH="$(resolve_clean_path)"
RUNNER_APP_BUNDLE_ID="${AGENT_DEVICE_IOS_BUNDLE_ID:-${AGENT_DEVICE_IOS_RUNNER_APP_BUNDLE_ID:-$DEFAULT_IOS_RUNNER_APP_BUNDLE_ID}}"
RUNNER_TEST_BUNDLE_ID="${AGENT_DEVICE_IOS_RUNNER_TEST_BUNDLE_ID:-$RUNNER_APP_BUNDLE_ID.uitests}"
SIGNING_BUILD_SETTINGS=""

if [ "$PLATFORM" = "macos" ]; then
  SIGNING_BUILD_SETTINGS="CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY= DEVELOPMENT_TEAM="
fi

if is_truthy "${AGENT_DEVICE_IOS_CLEAN_DERIVED:-}"; then
  rm -rf "$CLEAN_PATH"
fi

xcodebuild build-for-testing \
  -project "$PROJECT_PATH" \
  -scheme "$SCHEME" \
  -destination "$DESTINATION" \
  -derivedDataPath "$DERIVED_PATH" \
  AGENT_DEVICE_IOS_RUNNER_APP_BUNDLE_ID="$RUNNER_APP_BUNDLE_ID" \
  AGENT_DEVICE_IOS_RUNNER_TEST_BUNDLE_ID="$RUNNER_TEST_BUNDLE_ID" \
  COMPILER_INDEX_STORE_ENABLE=NO \
  ENABLE_CODE_COVERAGE=NO \
  -IDEPackageSupportDisableManifestSandbox=1 \
  -IDEPackageSupportDisablePluginExecutionSandbox=1 \
  ENABLE_USER_SCRIPT_SANDBOXING=NO \
  OTHER_SWIFT_FLAGS='$(inherited) -disable-sandbox' \
  $SIGNING_BUILD_SETTINGS

node --experimental-strip-types scripts/patch-xcuitest-runner-icon.ts "$DERIVED_PATH"
node scripts/write-xcuitest-cache-metadata.mjs "$PLATFORM" "$DERIVED_PATH" "$DESTINATION"
