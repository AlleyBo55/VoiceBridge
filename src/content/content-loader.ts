/**
 * Content script loader — Chrome can't use ES module imports in content scripts.
 * This tiny loader dynamically imports the real content-script module.
 */
(async () => {
  const src = chrome.runtime.getURL('content-script.js');
  await import(src);
})();
