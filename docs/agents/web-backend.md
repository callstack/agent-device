# Web Backend

Web automation uses a managed `agent-browser` backend as an implementation detail.

- Runtime web commands resolve the backend only from the state-dir managed install at `tools/agent-browser/<version>`.
- Normal `--platform web` commands do not install the managed backend on first use.
  If the backend is missing, they fail with a setup hint.
- Before first web automation or in CI/sandbox bootstrap steps, use `agent-device web setup`.
- To run the backend health check, use `agent-device web doctor`.
- The managed install respects `--state-dir` / `AGENT_DEVICE_STATE_DIR`.
- Web automation requires Node 24+.
  The rest of agent-device keeps its Node 22 baseline.
- Each backend call spawns the package's declared `bin` entry with the current Node runtime.
  It never spawns the `node_modules/.bin` console shim.
  Windows supplies that shim as `.cmd`.
  Without a shell, `child_process.spawn` refuses it because of CVE-2024-27980 hardening.
  A shell would reintroduce hazards from argument quoting.
  Only `runManagedAgentBrowser` executes the backend.
  Except on Windows, setup spawns `npm` from PATH as before.
  On Windows, bare `npm` is not spawnable.
  Instead, npm's own `npm-cli.js` runs under the current Node.

Default first-run flow:

```sh
agent-device web setup
agent-device open "https://example.com" --platform web
agent-device snapshot -i --platform web
agent-device viewport 1280 900 --platform web
agent-device screenshot ./artifacts/web-full.png --platform web --fullscreen
agent-device network dump 25 --platform web
agent-device close --platform web
```

Do not document direct `agent-browser` commands as agent-device features.
Web `network dump` is the narrow exception.
It adapts `agent-browser network requests` to the existing agent-device network evidence shape.
Until an explicit agent-device command design exists for them, exclude these features from the minimal web surface:

- Browser-specific network routing/interception/HAR.
- CDP.
- React web.
- Tabs.
- Downloads.
- Auth vaults.
- Profiling.
