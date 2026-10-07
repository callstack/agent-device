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

Worker:
  agent-device connect proxy --daemon-base-url https://host.example:8443/agent-device --daemon-auth-token <token>

See also: help remote (plain proxy and remote profiles).`,
  },
};
