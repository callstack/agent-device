# Web Backend

Web automation uses a managed `agent-browser` backend as an implementation detail.

- Runtime web commands resolve the backend only from the state-dir managed install at `tools/agent-browser/<version>`.
- Normal `--platform web` commands do not install the managed backend on first use. If the backend is missing, they fail with a setup hint.
- Use `agent-device web setup` before first web automation and in CI/sandbox bootstrap steps.
- Use `agent-device web doctor` to run the backend health check.
- The managed install respects `--state-dir` / `AGENT_DEVICE_STATE_DIR`.
- Web automation requires Node 24+ while the rest of agent-device keeps its Node 22 baseline.

Default first-run flow:

```sh
agent-device web setup
agent-device open "https://example.com" --platform web
agent-device snapshot -i --platform web
agent-device close --platform web
```

Do not document direct `agent-browser` commands as agent-device features. Browser-specific network,
CDP, React web, tabs, downloads, auth vaults, and profiling stay out of the minimal web surface until
there is an explicit agent-device command design for them.
