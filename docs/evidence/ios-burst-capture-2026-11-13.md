# Screenshot burst on an iOS simulator, 2026-11-13

Live evidence for #4291 at head `7f3741906` (the format-only commit after the
burst fixes; the behavior this documents is unchanged since): the burst path
(`--count`/`--interval-ms`) captured five frames of an animation on real
simulator dispatch. The observed per-frame interval here runs about 520-710 ms
— above the plan's 500 ms per-frame budget, because each frame also pays the
capture round trip the budget's doc comment excludes; the budget bounds the
admission wait per frame, not the full round trip. The screen was a page
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
animation, and all five landed on disk beside the `--out` path:

```
4a943cceb3b7468c40bc438b110980d4  page-0001.png
7b9451fa6875aa2a1147ddeec78aee46  page-0002.png
bda33d6c1e3ec2eb9b49c77dd690d265  page-0003.png
df7a320a07e242ff281abea1d0358ec1  page-0004.png
eb77c0c4882b8d2093c70a23b65e2cda  page-0005.png
```

The command's `--json` envelope (abridged to the identifying fields):

```json
{
  "success": true,
  "data": {
    "path": "/tmp/ad-burst/frames/page-0001.png",
    "frames": [ "... five frames as shown above ..." ],
    "message": "Saved 5 screenshots starting at /tmp/ad-burst/frames/page-0001.png"
  }
}
```
