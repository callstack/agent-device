import fs from 'node:fs';
// oxlint-disable-next-line no-restricted-imports -- scopes HOME to the run's TMPDIR; must read the real tmpdir
import os from 'node:os';
import path from 'node:path';

// The runner's derived-data root, cache locks, and leases resolve under the home directory. Tests
// that build there share those paths with every other process on the host, so a lock another run
// (or an interrupted one) left behind stalls them for the owner grace. Scope the home directory to
// this worker; global setup removes the run's TMPDIR. This module must load before any runner
// module, which reads the home directory at import.
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'apple-runner-home-'));
