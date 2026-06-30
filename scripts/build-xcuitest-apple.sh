#!/bin/sh
set -eu

PLATFORM="${AGENT_DEVICE_XCUITEST_PLATFORM:-}"
PROJECT_PATH="ios-runner/AgentDeviceRunner/AgentDeviceRunner.xcodeproj"
SCHEME="AgentDeviceRunner"
DEFAULT_IOS_RUNNER_APP_BUNDLE_ID="com.callstack.agentdevice.runner"

if [ -z "$PLATFORM" ]; then
  echo "AGENT_DEVICE_XCUITEST_PLATFORM is required (ios, macos, tvos, visionos)" >&2
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
      resolve_simulator_destination 'iOS' 'iPhone' || printf '%s\n' 'generic/platform=iOS Simulator'
      ;;
    macos)
      printf 'platform=macOS,arch=%s\n' "$(uname -m)"
      ;;
    tvos)
      resolve_simulator_destination 'tvOS' 'Apple TV' || printf '%s\n' 'generic/platform=tvOS Simulator'
      ;;
    visionos)
      resolve_simulator_destination 'visionOS' 'Apple Vision' || printf '%s\n' 'generic/platform=visionOS Simulator'
      ;;
    *)
      echo "Unsupported AGENT_DEVICE_XCUITEST_PLATFORM: $PLATFORM" >&2
      exit 1
      ;;
  esac
}

resolve_simulator_destination() {
  command -v node >/dev/null 2>&1 || return 1
  node -e '
const { execFileSync } = require("node:child_process");
const platformName = process.argv[1];
const deviceNamePattern = new RegExp(process.argv[2]);
const platformNameLower = platformName.toLowerCase();
try {
  const output = execFileSync("xcrun", ["simctl", "list", "devices", "available", "-j"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 3000,
  });
  const parsed = JSON.parse(output);
  const devices = Object.entries(parsed.devices ?? {})
    .filter(([runtime]) => runtime.toLowerCase().includes(platformNameLower))
    .flatMap(([, runtimeDevices]) => Array.isArray(runtimeDevices) ? runtimeDevices : [])
    .filter(
      (device) =>
        device &&
        device.isAvailable !== false &&
        typeof device.udid === "string" &&
        typeof device.name === "string" &&
        deviceNamePattern.test(device.name),
    );
  const selected = devices.find((device) => device.state === "Booted") ?? devices[0];
  if (!selected) process.exit(1);
  console.log(`platform=${platformName} Simulator,id=${selected.udid}`);
} catch {
  process.exit(1);
}
' "$1" "$2"
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
    visionos)
      printf '%s\n' "$HOME/.agent-device/ios-runner/derived/visionos"
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
    macos|tvos|visionos)
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

SWIFT_FLAGS='$(inherited) -disable-sandbox'
if is_truthy "${AGENT_DEVICE_XCUITEST_INCLUDE_UNIT_TESTS:-}"; then
  SWIFT_FLAGS="$SWIFT_FLAGS -D AGENT_DEVICE_RUNNER_UNIT_TESTS"
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
  ONLY_ACTIVE_ARCH=YES \
  ENABLE_PREVIEWS=NO \
  ENABLE_DEBUG_DYLIB=NO \
  -IDEPackageSupportDisableManifestSandbox=1 \
  -IDEPackageSupportDisablePluginExecutionSandbox=1 \
  ENABLE_USER_SCRIPT_SANDBOXING=NO \
  OTHER_SWIFT_FLAGS="$SWIFT_FLAGS" \
  $SIGNING_BUILD_SETTINGS

node --experimental-strip-types scripts/patch-xcuitest-runner-icon.ts "$DERIVED_PATH"
node scripts/write-xcuitest-cache-metadata.mjs "$PLATFORM" "$DERIVED_PATH" "$DESTINATION"
