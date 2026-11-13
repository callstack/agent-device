# Screenshot burst on an iOS simulator, 2026-11-13

Live evidence for #4291: the burst path (`--count`/`--interval-ms`) captured
five frames of an animation on real simulator dispatch. The screen was a page
served to Safari on the booted iPhone 17 Pro simulator
(`C1C05FFF-29AD-40D8-94E5-D9CBB25EC6BB`, iOS 26.5) whose content updates every
50 ms (a millisecond clock and a progress bar), so consecutive frames cannot
hash the same.

## The run

`agent-device screenshot /tmp/ad-burst/frames/page.png --count 5 --interval-ms
200 --platform ios --json` at the pushed head:

```json
{
  "frames": [
    { "path": "/tmp/ad-burst/frames/page-0001.png", "capturedAtMs": 1794583109757 },
    { "path": "/tmp/ad-burst/frames/page-0002.png", "capturedAtMs": 1794583110561 },
    { "path": "/tmp/ad-burst/frames/page-0003.png", "capturedAtMs": 1794583111470 },
    { "path": "/tmp/ad-burst/frames/page-0004.png", "capturedAtMs": 1794583112194 },
    { "path": "/tmp/ad-burst/frames/page-0005.png", "capturedAtMs": 1794583112995 }
  ]
}
```

`capturedAtMs` strictly increases. The five files on disk:

```
-rw-r--r--  20251  page-0001.png
-rw-r--r--  20457  page-0002.png
-rw-r--r--  19326  page-0003.png
-rw-r--r--  20858  page-0004.png
-rw-r--r--  20986  page-0005.png
```

Five distinct md5 hashes — every frame captured a different render of the
animation, and all five landed on disk beside the `--out` path.
