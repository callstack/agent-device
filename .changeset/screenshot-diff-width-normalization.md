---
'agent-device': patch
---

Compare screenshots at different resolutions without resizing them first. `diff screenshot` scales the current image to the baseline width, aligns both images at the top left, and counts extra or missing bottom rows as differences, even at `--threshold 1`. Your original files stay unchanged.

For different-size inputs, the result replaces `dimensionMismatch` with `normalization`, which reports original, scaled, and compared dimensions plus coordinate scales. Update consumers that read `dimensionMismatch` to use `normalization`; different-size images can now match after scaling instead of always reporting 100% mismatch. Region and ref-match rectangles use comparison pixels.
