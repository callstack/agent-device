---
'agent-device': patch
---

iOS simulator taps by ref work again on a full-screen app while the runner reads the screen through its private accessibility fallback, for example right after a large web view loads. Since 0.21.37 they failed with `window-origin-unknown`: under the XCTest channel penalty the fallback's viewport came from the tree's root frame and was never reported. A root that is exactly the screen at the origin, while AXRuntime reports the target as the primary app filling that screen, now establishes the screen origin. A placed iPad window, a root that is offset, and a root with width and height swapped still refuse coordinate-derived actions.
