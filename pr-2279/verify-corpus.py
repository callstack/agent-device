import json
from pathlib import Path

ROOT = Path(__file__).parent
SCREENS = ['quiet', 'list', 'nested-scroll', 'alert', 'system-surface', 'xctest-stress']
ANCHORS = dict(zip(SCREENS, ['Inert surface', 'Catalog', 'WebView accessibility', 'Automation confirmation', 'Settings', 'Checkout form']))
summary = {}
for name in ['base-warm', 'candidate-warm']:
    root = ROOT / name
    result = json.loads((root / 'samples.json').read_text())
    observations = json.loads((root / 'observations.json').read_text())
    assert result['status'] == 'completed'
    assert json.loads((root / 'stops.json').read_text()) == []
    assert result['revision']['dirty'] is False
    assert [m['screen'] for m in result['measurements']] == SCREENS
    cells = []
    for measurement in result['measurements']:
        screen = measurement['screen']
        samples = measurement['samples']
        assert len(samples) == 20 and measurement['failures'] == 0
        assert all(s['ok'] and s['firstTree'] == 'readable' for s in samples)
        captures = [o for o in observations if o['screen'] == screen and o['phase'] == 'sample']
        assert len(captures) == 20
        warnings = set()
        for capture in captures:
            assert capture['result']['ok']
            data = capture['result']['payload']['data']['results'][0]['data']
            assert any(n.get('label') == ANCHORS[screen] or n.get('value') == ANCHORS[screen] for n in data['nodes'])
            warnings.update(data.get('warnings', []))
        if name == 'candidate-warm':
            events = [json.loads(line) for line in (root / (screen + '-initial.ndjson')).read_text().splitlines()]
            assert any(e['phase'] == 'ios.snapshot-source.acquire' and e['data']['producer'] == 'simulator-ax-bridge' for e in events)
            assert any(e['phase'] == 'ios.snapshot-source.present' and e['data']['producer'] == 'simulator-ax-bridge' for e in events)
            assert not any('fallback' in warning.lower() for warning in warnings)
        cells.append({k: measurement[k] for k in ['screen', 'wallClockMs', 'daemonDurationMs', 'failures', 'failureCategories']})
    summary[name] = {'revision': result['revision']['commit'], 'samples': 120, 'cells': cells}
print(json.dumps(summary, indent=2))
