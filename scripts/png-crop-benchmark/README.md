# PNG crop benchmark

```sh
pnpm bench:png-crop -- --rounds 5
pnpm bench:png-crop -- --rounds 5 --file /path/to/real-capture.png
```

Compares the two ways this repository can crop a screenshot. Both run over the same bytes as PNG
worker jobs in one process, so what differs is the algorithm and not the thread it happens to land
on, or a file write on one side only:

- `whole-image` — the previous crop: one job decodes the whole capture to RGBA, the box rows are
  copied out of that bitmap, and a second job encodes the box.
- `region` — the shipped crop: one job reads the box's rows and encodes them, as RGB rather than
  RGBA whenever the cropped pixels are all opaque.

The corpus is generated, so a full run costs seconds and needs no device. Generated captures are
written to `.tmp/png-crop-benchmark/` and each one's compressed size is printed under the table:
a corpus that stops resembling a real capture becomes visible there instead of flattering the
result. Pass real captures with `--file` (repeatable) to put their numbers in the same table; the
real captures decide the verdict, since generated content cannot match a device's deflate stream.

## What is actually saved

Neither pipeline reads less of the file: a deflate stream has to be inflated to its end, so both
inflate the whole compressed image, and the region path inflates it into a buffer sized for every
filtered row in the capture. What the region path saves is the pixel work — reconstructing only down
to the box's last row and producing only the box's pixels, instead of a full RGBA bitmap for the
whole capture — plus one worker round trip, and the RGBA re-encode of the answer.

## What the measurements have said

Measured at that matched boundary over 7 rounds, on captures taken from an iOS Simulator and an
Android Emulator: the iOS captures go 2.5x to 5.6x faster and their crops come out 1.04x to 2.16x
smaller, mostly because an opaque crop is written as RGB instead of RGBA. A flat UI capture gains
the most, because the previous pipeline still expands the whole capture to an RGBA bitmap whatever
the filters look like, while the region path skips the pixels above the box.

The noisiest capture in that set — a full-screen Android `screencap`, 1.4 MB compressed — is a wash
on time (1.0x to 1.6x) and its crop comes out up to 1.13x *larger*. Inflating and reconstructing
that much entropy dominates both pipelines, and the region writer's `None` filter cannot beat the
general writer's filter search on content that noisy. Check your own captures with `--file` before
reading a win or a loss into any number here.

The encoder keeps the `None` filter on every scanline. Scoring the five PNG filters per row is
1.4x to 2.6x slower and produces a *larger* file on UI captures, where the smallest-sum-of-absolute-
differences heuristic prefers Sub or Up on text rows that deflate smaller unfiltered. On synthetic
low-frequency content — the `photo` captures here, which are smooth 8px blocks — `None` is still
faster but writes about 1.7x more bytes than a filtered encoding would. Real photo-filled captures
still come out smaller with `None` than with the general writer's own filter search, so the corpus
here overstates that case; check your own captures with `--file` before treating it as a limit.
