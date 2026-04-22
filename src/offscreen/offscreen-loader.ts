/**
 * Offscreen document loader.
 * Dynamically imports the real offscreen module to ensure chrome APIs are available.
 */
(async () => {
  const src = chrome.runtime.getURL('offscreen.js');
  await import(src);
})();
