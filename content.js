/**
 * TabAssist Content Script
 * 
 * Runs on Songsterr tab pages to receive jump commands from the popup
 * and synthesize smooth key events to advance guitar tab measures.
 */

// Cross-browser extension API fallback
const extensionAPI = typeof browser !== 'undefined' ? browser : chrome;

// Default scroll distance (number of measure down jumps)
let JUMP_FACTOR = 4;

// Synchronize jump sensitivity setting from storage
if (typeof extensionAPI !== 'undefined' && extensionAPI.storage && extensionAPI.storage.sync) {
  extensionAPI.storage.sync.get({ jumpFactor: 4 }, (items) => {
    JUMP_FACTOR = items.jumpFactor;
  });

  extensionAPI.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.jumpFactor) {
      JUMP_FACTOR = changes.jumpFactor.newValue;
    }
  });
}

/**
 * Dispatches simulated ArrowDown keydown events to Songsterr player.
 * @param {number} measures - Number of measure increments to move forward.
 */
function triggerSongsterrJump(measures = JUMP_FACTOR) {
  const target = document.activeElement || document.body || document;
  
  for (let i = 0; i < measures; i++) {
    target.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'ArrowDown',
      code: 'ArrowDown',
      keyCode: 40,
      which: 40,
      bubbles: true,
      cancelable: true
    }));
  }
}

// Register incoming command listener
if (typeof extensionAPI !== 'undefined' && extensionAPI.runtime && extensionAPI.runtime.onMessage) {
  extensionAPI.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'TRIGGER_JUMP') {
      triggerSongsterrJump();
      sendResponse({ status: 'success', measuresJumped: JUMP_FACTOR });
    }
    return true; // Keep message channel open for async response
  });
}