#!/usr/bin/env bash
set -euo pipefail

if [ "${GITHUB_ACTIONS:-}" != true ]; then
  echo 'iOS smoke teardown is only for GitHub Actions runners.' >&2
  exit 1
fi

status=0
pnpm clean:daemon || status=1
xcrun simctl shutdown all || status=1
osascript -e 'if application "Simulator" is running then tell application "Simulator" to quit' || status=1
node --input-type=module <<'JS' || status=1
import { execFileSync } from 'node:child_process';
import path from 'node:path';
const inventory = JSON.parse(execFileSync('xcrun', ['simctl', 'list', 'devices', '--json'], { encoding: 'utf8' }));
const booted = Object.values(inventory.devices ?? {}).flat().filter((device) => device.state === 'Booted');
if (booted.length) throw new Error(`Simulators remain booted: ${booted.map((device) => device.udid).join(', ')}`);
const remaining = execFileSync('ps', ['-axo', 'comm='], { encoding: 'utf8' }).split('\n').map((entry) => path.basename(entry.trim())).filter((name) => /^(?:AgentDeviceRunner.*|xcodebuild|xctest|XCTRunner|Simulator)$/.test(name));
if (remaining.length) throw new Error(`iOS smoke processes remain: ${remaining.join(', ')}`);
JS
mkdir -p test/screenshots
screencapture -x test/screenshots/apple-host-after-ios.png || echo "Could not capture the host teardown screenshot." >&2
osascript scripts/decline-hosted-compute-local-network.applescript || status=1
osascript -e 'tell application "Finder" to activate' || status=1
frontmost="$(osascript -e 'tell application "System Events" to get bundle identifier of first application process whose frontmost is true')" || status=1
if [ "$frontmost" != com.apple.finder ]; then
  echo "Host focus was not restored to Finder: $frontmost" >&2
  status=1
fi
exit "$status"
