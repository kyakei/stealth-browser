import { Page } from 'playwright';
import { Logger } from '@utils/logger';

/**
 * Cloudflare interstitial solver — ported from Scrapling's `_detect_cloudflare`
 * + `_cloudflare_solver` (github.com/D4Vinci/Scrapling, MIT).
 *
 * This handles the "Verify you are human" / "Just a moment…" wall that
 * Cloudflare throws *as a full page*. It is NOT a generic captcha solver —
 * if Cloudflare escalates to a real interactive Turnstile puzzle, this won't
 * crack it (fall back to the 2captcha-backed `browser_solve_captcha` then).
 *
 * How it works:
 *   - non-interactive ("Just a moment…") → the JS challenge auto-passes if the
 *     browser fingerprint is clean; we just wait for the page to swap.
 *   - managed / interactive → there's a Turnstile checkbox inside an iframe;
 *     compute its on-screen coords, do a real mouse click, wait, recurse.
 *   - embedded → Turnstile widget rendered inline on the page (often inside a
 *     closed shadow iframe); same coordinate-click approach, different selector.
 *
 * Relies on the browser fingerprint being good enough that Cloudflare's risk
 * score stays low — which is what the chrome-flags.ts stealth flags + the
 * stealth plugin are for.
 */

const CF_IFRAME_RE = /^https?:\/\/challenges\.cloudflare\.com\/cdn-cgi\/challenge-platform\//;

export type CloudflareChallengeType = 'non-interactive' | 'managed' | 'interactive' | 'embedded' | null;

export interface CloudflareDetectResult {
  challenge: CloudflareChallengeType;
  evidence: string[];
}

export interface CloudflareSolveResult {
  challenge: CloudflareChallengeType;
  solved: boolean;
  attempts: number;
  durationMs: number;
}

function sleep(ms: number) {
  return new Promise<void>(res => setTimeout(res, ms));
}

/** Inspect page HTML to classify any Cloudflare challenge present. */
export async function detectCloudflare(page: Page): Promise<CloudflareDetectResult> {
  const html = await page.content().catch(() => '');
  const evidence: string[] = [];
  for (const ctype of ['non-interactive', 'managed', 'interactive'] as const) {
    if (html.includes(`cType: '${ctype}'`)) {
      evidence.push(`page source contains cType: '${ctype}'`);
      return { challenge: ctype, evidence };
    }
  }
  // Turnstile script embedded directly in the page (managed Turnstile widget,
  // often inside a closed shadow iframe).
  if (/<script[^>]+src="[^"]*challenges\.cloudflare\.com\/turnstile\/v/.test(html)) {
    evidence.push('embedded challenges.cloudflare.com/turnstile script tag');
    return { challenge: 'embedded', evidence };
  }
  // Heuristic: "Just a moment..." title with no cType is usually a non-interactive wait.
  if (/<title>Just a moment\.\.\.<\/title>/.test(html)) {
    evidence.push('"Just a moment..." title');
    return { challenge: 'non-interactive', evidence };
  }
  return { challenge: null, evidence };
}

/**
 * Attempt to clear a Cloudflare interstitial on the current page.
 * `maxRecursion` bounds the retry depth (each retry re-detects + re-clicks).
 */
export async function solveCloudflareInterstitial(
  page: Page,
  opts: { maxRecursion?: number; pollMs?: number } = {},
): Promise<CloudflareSolveResult> {
  const start = Date.now();
  const maxRecursion = opts.maxRecursion ?? 3;
  const pollMs = opts.pollMs ?? 1000;
  let attempts = 0;

  const stillJustAMoment = async () => /<title>Just a moment\.\.\.<\/title>/.test(await page.content().catch(() => ''));

  const solveOnce = async (depth: number): Promise<{ challenge: CloudflareChallengeType; solved: boolean }> => {
    attempts++;
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    const { challenge } = await detectCloudflare(page);
    if (!challenge) {
      Logger.info('cloudflare: no challenge detected (or already solved)');
      return { challenge: null, solved: true };
    }
    Logger.info('cloudflare: challenge detected', { challenge, depth });

    if (challenge === 'non-interactive') {
      // Just wait for the "Just a moment…" page to swap to real content.
      for (let i = 0; i < 30; i++) {
        if (!(await stillJustAMoment())) {
          Logger.info('cloudflare: interstitial cleared (non-interactive)');
          return { challenge, solved: true };
        }
        await sleep(pollMs);
        await page.waitForLoadState().catch(() => {});
      }
      return { challenge, solved: !(await stillJustAMoment()) };
    }

    // managed / interactive / embedded → click the Turnstile checkbox.
    const isEmbedded = challenge === 'embedded';
    const fallbackBox = isEmbedded
      ? '#cf_turnstile div, #cf-turnstile div, .turnstile>div>div, .cf-turnstile>div'
      : '.main-content p+div>div>div';

    // For the full-page managed/interactive challenge, wait out the "Verifying…" spinner.
    if (!isEmbedded) {
      for (let i = 0; i < 20; i++) {
        const c = await page.content().catch(() => '');
        if (!c.includes('Verifying you are human.')) break;
        await sleep(500);
      }
    }

    let box: { x: number; y: number; width: number; height: number } | null = null;
    const iframe = page.frames().find(f => CF_IFRAME_RE.test(f.url()));
    if (iframe) {
      const fe = await iframe.frameElement().catch(() => null);
      if (fe) {
        // Give the iframe a beat to render.
        for (let i = 0; i < 10 && !(await fe.isVisible().catch(() => false)); i++) await sleep(500);
        box = await fe.boundingBox().catch(() => null);
      }
    }
    if (!box) {
      if (!(await stillJustAMoment())) {
        Logger.info('cloudflare: cleared while locating iframe');
        return { challenge, solved: true };
      }
      box = await page.locator(fallbackBox).last().boundingBox().catch(() => null);
    }
    if (!box) {
      Logger.warn('cloudflare: could not locate the Turnstile checkbox box');
      return { challenge, solved: false };
    }

    // The checkbox sits ~26px right, ~26px down from the widget's top-left.
    const cx = box.x + 26 + Math.floor(Math.random() * 3);
    const cy = box.y + 25 + Math.floor(Math.random() * 3);
    Logger.info('cloudflare: clicking Turnstile checkbox', { cx, cy });
    await page.mouse.click(cx, cy, { delay: 100 + Math.floor(Math.random() * 100), button: 'left' });
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});

    if (!isEmbedded) {
      for (let i = 0; i < 100; i++) {
        if (!(await stillJustAMoment())) break;
        await sleep(100);
      }
      await page.waitForLoadState().catch(() => {});
    }

    if (!isEmbedded && (await stillJustAMoment())) {
      if (depth < maxRecursion) {
        Logger.info('cloudflare: still present, retrying');
        return solveOnce(depth + 1);
      }
      return { challenge, solved: false };
    }
    Logger.info('cloudflare: interstitial cleared');
    return { challenge, solved: true };
  };

  const { challenge, solved } = await solveOnce(0);
  return { challenge, solved, attempts, durationMs: Date.now() - start };
}
