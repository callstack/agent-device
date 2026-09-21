/**
 * Why a contact sheet was not drawn. Each reason is a typed constant the extraction path fails with,
 * so a caller branches on the reason instead of reading an error message.
 */

/** The host cannot extract frames at all: frame decoding is Apple AVFoundation tooling. */
export const CONTACT_SHEET_UNSUPPORTED_HOST_REASON = 'contact_sheet_unsupported_host';
/** Frame extraction ran and failed, rather than returning fewer frames. */
export const CONTACT_SHEET_EXTRACTION_REASON = 'contact_sheet_frame_extraction_failed';
/** Extraction returned nothing usable, so there is no sheet to draw. */
export const CONTACT_SHEET_NO_FRAMES_REASON = 'contact_sheet_no_frames';
