#import "RunnerPanelSurface.h"
#import "ForegroundApplicationGeometry.h"
#import <math.h>

BOOL RunnerPanelFrameIsLitPanelSurface(CGRect frame, RunnerLitPanel litPanel) {
  if (!AgentDeviceForegroundFrameIsMeasurable(frame)) {
    return NO;
  }
  if (fabs(frame.origin.x) > AGENT_DEVICE_PANEL_SURFACE_TOLERANCE ||
      fabs(frame.origin.y) > AGENT_DEVICE_PANEL_SURFACE_TOLERANCE) {
    return NO;
  }
  if (!isfinite(litPanel.widthPt) || !isfinite(litPanel.heightPt)) {
    return NO;
  }
  BOOL upright =
    fabs(frame.size.width - litPanel.widthPt) <= AGENT_DEVICE_PANEL_SURFACE_TOLERANCE &&
    fabs(frame.size.height - litPanel.heightPt) <= AGENT_DEVICE_PANEL_SURFACE_TOLERANCE;
  // A panel the system presents turned reports its window in that panel's own native space, so the
  // iPhone Duo inner panel's 951x669 interaction box is the transpose of the 669x951 the panel table
  // names for it (ADR 0025).
  BOOL turned =
    fabs(frame.size.width - litPanel.heightPt) <= AGENT_DEVICE_PANEL_SURFACE_TOLERANCE &&
    fabs(frame.size.height - litPanel.widthPt) <= AGENT_DEVICE_PANEL_SURFACE_TOLERANCE;
  return upright || turned;
}

static CGFloat RunnerPanelWindowFrameArea(CGRect frame) {
  CGFloat width = frame.size.width > 1 ? frame.size.width : 1;
  CGFloat height = frame.size.height > 1 ? frame.size.height : 1;
  return width * height;
}

RunnerPanelSurfaceSelection RunnerPanelSurfaceSelectWindow(
  const RunnerPanelWindowFact *windows,
  NSUInteger count,
  RunnerLitPanel litPanel,
  RunnerPanelWindowFact *selected,
  NSUInteger *selectedIndex
) {
  if (selected != NULL) {
    *selected = (RunnerPanelWindowFact){.displayID = 0, .frame = CGRectNull};
  }
  if (selectedIndex != NULL) {
    *selectedIndex = NSUIntegerMax;
  }
  if (windows == NULL || count == 0) {
    return RunnerPanelSurfaceSelectionNoWindow;
  }
  if (selected != NULL) {
    *selected = windows[0];
  }
  if (selectedIndex != NULL) {
    *selectedIndex = 0;
  }

  RunnerPanelWindowFact largestPlaced = windows[0];
  NSUInteger largestPlacedIndex = 0;
  BOOL sawPlaced = NO;
  CGFloat largestPlacedArea = 0;
  for (NSUInteger index = 0; index < count; index += 1) {
    RunnerPanelWindowFact candidate = windows[index];
    if (candidate.displayID != litPanel.displayID) {
      continue;
    }
    if (RunnerPanelFrameIsLitPanelSurface(candidate.frame, litPanel)) {
      if (selected != NULL) {
        *selected = candidate;
      }
      if (selectedIndex != NULL) {
        *selectedIndex = index;
      }
      return RunnerPanelSurfaceSelectionLitPanelWindow;
    }
    CGFloat area = RunnerPanelWindowFrameArea(candidate.frame);
    if (!sawPlaced || area > largestPlacedArea) {
      sawPlaced = YES;
      largestPlacedArea = area;
      largestPlaced = candidate;
      largestPlacedIndex = index;
    }
  }
  if (sawPlaced) {
    if (selected != NULL) {
      *selected = largestPlaced;
    }
    if (selectedIndex != NULL) {
      *selectedIndex = largestPlacedIndex;
    }
    return RunnerPanelSurfaceSelectionLitDisplayWindow;
  }
  // The lit display named no window, so every window the app has is on the dark panel. Taking the
  // biggest of them by geometry would book a gesture or a capture on a screen nobody is looking at,
  // so this refuses and leaves the caller to report the panel it looked at.
  return RunnerPanelSurfaceSelectionOffLitPanel;
}
