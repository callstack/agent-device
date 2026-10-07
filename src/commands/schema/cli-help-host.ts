export const hostHelpTopics = {
  host: {
    summary: 'Host front-end for remote verification workers',
    body: `agent-device help host

The host command runs the Host front-end on the Mac that owns the devices. It is a separate process
from the daemon: it starts or reuses the local HTTP daemon and forwards remote requests to it over
loopback with the local daemon token.

Service credential:
  Created at <state dir>/host/service-credential.json (mode 0600, directory 0700) once Host is
  serving. The token is printed on that start only; read it from the file afterwards.
  Every later start reuses the same credential, so workers survive Host restarts.
  Host refuses to start when the file is malformed, a link, or open to group or others.
  Rotate by deleting the file and restarting Host; workers then need the new token.

Serving:
  --host <host> --port <port>      Bind address (default 127.0.0.1, free port)
  --tls-cert <path> --tls-key <path>  Serve HTTPS; both are required together
  Any bind other than loopback needs TLS. The key must match the certificate.
  A wildcard bind such as 0.0.0.0 advertises the machine's hostname.
  These checks all run before a daemon is started.
  Routes match proxy: /health, /rpc, uploads, /artifacts, request diagnostics, also under /agent-device/*.
  GET /health is public. Every other route needs the service token (401 without it);
  unserved routes get 404.

Public route policy:
  Host drops any identity a client claims (tenant headers and body fields) and forwards the
  credential's principal to the daemon, which isolates sessions under it.
  Refused with 403 and a typed details.reason:
    host-admin-refused               macos-app lease allocation (/admin/* is not served)
    host-path-refused                inputs naming a path on the Host machine, batch steps included
    host-component-download-refused  allowDownload
    host-script-refused              replay and test, whose nested actions Host cannot check
  Anonymous /health shows only ok, service and rpcProtocolVersion.

Requesting a device:
  agent-device open com.example.app --platform ios --device "iPhone 16"
  agent-device open com.example.app --platform android --device "Pixel 7" --os-version 15
  On Host, --device names a device type. Host allocates a fresh device for every lease instead
  of resolving the name against inventory; never pass a UDID or serial.
  A Host whose daemon has no device allocator refuses this with host-shape-unsupported before
  any lease is requested.

Installing a verification build:
  agent-device install-from-source https://ci.example.com/app.zip --platform ios
  agent-device install-from-source --github-actions-artifact acme/mobile:ios-sim --platform ios
  The daemon resolves GitHub Actions artifacts, private ones included, with
  AGENT_DEVICE_GITHUB_TOKEN from its own environment: export it for the Host process, which
  passes it to the daemon it starts and refuses a running daemon that holds another token.
  AGENT_DEVICE_GITHUB_REPOSITORIES=owner/repo,... limits which repositories it reads.
  Workers never send a GitHub token or a Host path.

Worker:
  agent-device connect proxy --daemon-base-url https://host.example:8443/agent-device --daemon-auth-token <token>

See also: help remote (plain proxy and remote profiles).`,
  },
};
