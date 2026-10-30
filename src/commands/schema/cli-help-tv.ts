export const TV_PLUGIN_FLOWS = `LG webOS TV flow (web apps, TV in Developer Mode):
  export AGENT_DEVICE_SESSION=checkout-tv
  agent-device connect webos --device living-room
  agent-device open com.example.app
  Add the plugin with plugins add @agent-device/webos. After open, drive the app with tv-remote, snapshot, close and disconnect. Prerequisites: the webOS CLI (npm install -g @webos-tools/cli) and the TV in Developer Mode, registered with ares-setup-device. --device names an ares-setup-device entry; connect does not contact the TV, open reads it. The TV enters as an Android TV device with id webos:<ares device>. The page is driven over the Chrome DevTools Protocol through the ares-inspect tunnel.
`;
