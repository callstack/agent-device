# Web Backend

Web automation uses a managed `agent-browser` backend, an implementation detail.

- Web commands resolve the backend only from the state-dir install at `tools/agent-browser/<version>`.
- `--platform web` commands never install the backend. If it is missing, they fail with a setup hint.
- Before first web use or in CI/sandbox bootstrap, run `agent-device web setup`.
- For a backend health check, run `agent-device web doctor`.
- Only `runManagedAgentBrowser` executes the backend.
  Its `spawnManagedAgentBrowser` runs the declared `bin` entry under the current Node, never the `.bin` shim or a shell (quoting hazards).

Do not document direct `agent-browser` commands as agent-device features, except web `network dump`, which adapts `agent-browser network requests` to the network evidence shape.
Until an agent-device command design exists for them, exclude from the web surface: browser network routing, interception, and HAR; CDP; React web; tabs; downloads; auth vaults; and profiling.
