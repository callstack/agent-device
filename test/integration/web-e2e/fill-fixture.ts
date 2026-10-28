import { createServer, type Server } from 'node:http';

/**
 * Fixture page for coordinate `fill`. Every field is absolutely positioned so a test clicks a known
 * point, and every edit is mirrored into `<p aria-label="state">` as JSON so a test reads what the
 * page actually holds. The cross-origin frame is the same server under the `localhost` host name.
 */
export const FILL_FIXTURE_POINTS = {
  plain: [120, 35],
  textarea: [120, 100],
  contenteditable: [120, 165],
  shadowInput: [120, 215],
  shadowContenteditable: [120, 265],
  closedShadowInput: [120, 315],
  sameOriginFrame: [100, 370],
  crossOriginFrame: [100, 430],
  readonlyInput: [400, 35],
  dateInput: [320, 85],
  checkbox: [310, 130],
  select: [370, 165],
  button: [360, 220],
  blank: [650, 450],
} as const satisfies Record<string, readonly [number, number]>;

export type FillFixtureState = {
  plain: string;
  textarea: string;
  contenteditable: string;
  shadowInput: string;
  shadowContenteditable: string;
  closedShadowInput: string;
  sameOriginFrame: string;
  crossOriginFrame: string;
  readonlyInput: string;
  dateInput: string;
  checkbox: boolean;
  select: string;
  clicks: number;
  enters: number;
};

export async function startFillFixtureServer(): Promise<{ server: Server; port: number }> {
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://fixture').pathname;
    const html = pathname === '/' ? pageHtml() : pathname === '/frame' ? frameHtml() : null;
    if (html === null) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('not found');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(html);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address !== 'object') throw new Error('fixture has no port');
  return { server, port: address.port };
}

function frameHtml(): string {
  return `<!doctype html><meta charset="utf-8">
<body style="margin:0"><input id="field" value="old" style="width:240px;height:30px;box-sizing:border-box">
<script>
  const field = document.getElementById('field');
  const name = new URLSearchParams(location.search).get('name');
  field.addEventListener('input', () => parent.postMessage({ name, value: field.value }, '*'));
</script>`;
}

function pageHtml(): string {
  return `<!doctype html><meta charset="utf-8"><title>fill fixture</title>
<body style="margin:0;font:14px system-ui">
<style>
  .at { position: absolute; box-sizing: border-box; border: 1px solid #888; }
</style>
<input id="plain" class="at" value="old" style="left:20px;top:20px;width:200px;height:30px">
<textarea id="textarea" class="at" style="left:20px;top:70px;width:200px;height:60px">old</textarea>
<div id="contenteditable" class="at" contenteditable="true" style="left:20px;top:150px;width:200px;height:30px">old</div>
<div id="shadow-input-host" class="at" style="left:20px;top:200px;width:200px;height:30px"></div>
<div id="shadow-rich-host" class="at" style="left:20px;top:250px;width:200px;height:30px"></div>
<div id="closed-host" class="at" style="left:20px;top:300px;width:200px;height:30px"></div>
<iframe id="same" class="at" style="left:20px;top:350px;width:250px;height:40px;border:0"></iframe>
<iframe id="cross" class="at" style="left:20px;top:410px;width:250px;height:40px;border:0"></iframe>
<input id="readonly" class="at" value="old" readonly style="left:300px;top:20px;width:150px;height:30px">
<input id="date" class="at" type="date" value="2020-01-01" style="left:300px;top:70px;width:150px;height:30px">
<input id="checkbox" class="at" type="checkbox" style="left:300px;top:120px;width:20px;height:20px">
<select id="select" class="at" style="left:300px;top:150px;width:150px;height:30px"><option>old</option><option>other</option></select>
<button id="button" class="at" style="left:300px;top:200px;width:120px;height:40px">Go</button>
<p id="state" aria-label="state" class="at" style="left:20px;top:520px;border:0"></p>
<script>
  const sameOrigin = location.origin;
  const crossOrigin = 'http://localhost:' + location.port;
  document.getElementById('same').src = sameOrigin + '/frame?name=sameOriginFrame';
  document.getElementById('cross').src = crossOrigin + '/frame?name=crossOriginFrame';

  const reported = { sameOriginFrame: 'old', crossOriginFrame: 'old' };
  const shadowInputRoot = document.getElementById('shadow-input-host').attachShadow({ mode: 'open' });
  shadowInputRoot.innerHTML = '<input value="old" style="width:100%;height:100%;box-sizing:border-box">';
  const shadowRichRoot = document.getElementById('shadow-rich-host').attachShadow({ mode: 'open' });
  shadowRichRoot.innerHTML = '<div contenteditable="true" style="width:100%;height:100%">old</div>';
  const closedRoot = document.getElementById('closed-host').attachShadow({ mode: 'closed' });
  closedRoot.innerHTML = '<input value="old" style="width:100%;height:100%;box-sizing:border-box">';
  const closedInput = closedRoot.firstChild;

  let clicks = 0;
  let enters = 0;
  document.getElementById('button').addEventListener('click', () => { clicks += 1; render(); });
  document.addEventListener('keydown', (event) => { if (event.key === 'Enter') enters += 1; render(); });
  document.addEventListener('input', render, true);
  window.addEventListener('message', (event) => {
    if (event.data && event.data.name in reported) reported[event.data.name] = event.data.value;
    render();
  });

  function render() {
    document.getElementById('state').textContent = JSON.stringify({
      plain: document.getElementById('plain').value,
      textarea: document.getElementById('textarea').value,
      contenteditable: document.getElementById('contenteditable').textContent,
      shadowInput: shadowInputRoot.firstChild.value,
      shadowContenteditable: shadowRichRoot.firstChild.textContent,
      closedShadowInput: closedInput.value,
      sameOriginFrame: reported.sameOriginFrame,
      crossOriginFrame: reported.crossOriginFrame,
      readonlyInput: document.getElementById('readonly').value,
      dateInput: document.getElementById('date').value,
      checkbox: document.getElementById('checkbox').checked,
      select: document.getElementById('select').value,
      clicks,
      enters,
    });
  }
  render();
</script>`;
}
