/**
 * SyncStream Pro - Page Context Fullscreen Intercept
 * Runs in MAIN world at document_start.
 *
 * No interception — fullscreen behaves normally on all sites.
 * content.js fullscreenchange handler moves ss-root into the element.
 * For cross-origin iframe players we can't inject without breaking
 * native fullscreen, so the overlay is hidden there by browser design.
 */
