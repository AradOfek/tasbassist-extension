/**
 * TabAssist Extension Background Service Worker
 * 
 * Configures side panel behavior on extension icon click.
 */

const extensionAPI = typeof browser !== 'undefined' ? browser : chrome;

if (extensionAPI.sidePanel && extensionAPI.sidePanel.setPanelBehavior) {
  extensionAPI.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => console.error("[TabAssist Debug] Failed to set side panel behavior:", err));
}
