/**
 * Chrome launch flags — ported from Scrapling's DEFAULT_ARGS + STEALTH_ARGS
 * (github.com/D4Vinci/Scrapling, MIT). Two goals:
 *   - speed: kill background networking, breakpad, hang monitor, throttling, etc.
 *   - stealth: strip the automation tells Chrome adds, spoof desktop pointer/hover
 *     traits so headless-detection (`matchMedia('(hover:hover)')` etc.) doesn't fire.
 *
 * NOTE: attach-mode spawns Chrome directly (not via Playwright's launcher), so the
 * `--enable-automation` / `--disable-extensions` defaults Playwright would add are
 * never present — no `ignoreDefaultArgs` needed there. For the headless session-mode
 * browser (browser-manager, which DOES use playwright.launch), pass HARMFUL_DEFAULT_ARGS
 * as `ignoreDefaultArgs`.
 */

/** Playwright-added defaults that hurt stealth — strip via `ignoreDefaultArgs`. */
export const HARMFUL_DEFAULT_ARGS = [
  // Sets navigator.webdriver + shows the "controlled by automated software" infobar.
  // Also implicated in a Chromium popup-crash abuse: https://issues.chromium.org/issues/340836884
  '--enable-automation',
  '--disable-popup-blocking',
  '--disable-component-update',
  '--disable-default-apps',
  '--disable-extensions',
];

/**
 * The big flag set. Order doesn't matter to Chrome; grouped here for sanity.
 * Excludes anything that conflicts with a visible, human-in-the-loop window
 * (no --headless, no --incognito). Includes --start-maximized which both helps
 * the visible UX and is itself a headless-check bypass.
 */
export const STEALTH_CHROME_ARGS = [
  // ---- speed / quiet ----
  '--no-pings',
  '--no-first-run',
  '--no-default-browser-check',
  '--no-service-autorun',
  '--homepage=about:blank',
  '--password-store=basic',
  '--use-mock-keychain',
  '--metrics-recording-only',
  '--disable-breakpad',
  '--disable-crash-reporter',
  '--disable-hang-monitor',
  '--disable-sync',
  '--disable-translate',
  '--disable-voice-input',
  '--disable-wake-on-wifi',
  '--disable-cloud-import',
  '--disable-print-preview',
  '--disable-cookie-encryption',
  '--disable-gesture-typing',
  '--disable-partial-raster',
  '--disable-checker-imaging',
  '--disable-prompt-on-repost',
  '--disable-domain-reliability',
  '--disable-threaded-animation',
  '--disable-threaded-scrolling',
  '--disable-image-animation-resync',
  '--disable-background-networking',
  '--disable-renderer-backgrounding',
  '--disable-ipc-flooding-protection',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-layer-tree-host-memory-pressure',
  '--disable-new-content-rendering-timeout',
  '--disable-client-side-phishing-detection',
  '--disable-offer-upload-credit-cards',
  '--disable-offer-store-unmasked-wallet-cards',
  '--disable-session-crashed-bubble',
  '--disable-search-engine-choice-screen',
  '--disable-dev-shm-usage',
  '--aggressive-cache-discard',
  '--enable-simple-cache-backend',
  '--enable-tcp-fast-open',
  '--enable-async-dns',
  '--enable-surface-synchronization',
  '--ignore-gpu-blocklist',
  '--enable-web-bluetooth',
  '--mute-audio',
  '--prerender-from-omnibox=disabled',
  '--safebrowsing-disable-auto-update',
  '--run-all-compositor-stages-before-draw',
  '--autoplay-policy=user-gesture-required',
  '--force-color-profile=srgb',
  '--font-render-hinting=none',
  '--disable-features=Translate,TranslateUI,InfinitePrefetch,AudioServiceOutOfProcess,BlinkGenPropertyTrees',

  // ---- stealth ----
  '--test-type',                                  // suppresses some automation banners/restrictions
  '--disable-infobars',
  '--disable-blink-features=AutomationControlled', // the canonical navigator.webdriver fix
  '--disable-component-extensions-with-background-pages',
  // Force "real mouse + hover-capable desktop" — headless Chrome otherwise reports
  // hover:none / pointer:coarse (touchscreen-like), a dead giveaway.
  '--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4',
  '--lang=en-US',
  '--accept-lang=en-US',

  // ---- visible window ----
  '--start-maximized',
  '--window-position=0,0',
];
