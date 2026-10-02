/**
 * TabAssist Extension Background Service Worker
 * 
 * Enables the Chrome Side Panel API on action icon click so that the user
 * can keep camera face tracking open continuously alongside Songsterr.
 */

const extensionAPI = typeof browser !== 'undefined' ? browser : chrome;

// Automatically open side panel when extension icon is clicked
if (extensionAPI.sidePanel && extensionAPI.sidePanel.setPanelBehavior) {
  extensionAPI.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
    .catch((error) => console.error("[TabAssist Debug] Failed to set side panel behavior:", error));
}
