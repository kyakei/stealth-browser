import { spawn, ChildProcess } from 'child_process';
import * as http from 'http';
import * as fs from 'fs/promises';
import { randomUUID } from 'crypto';
import { Browser, BrowserContext, CDPSession, Page, Request, Response, Cookie } from 'playwright';
import { chromium as chromiumExtra } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { Logger } from '@utils/logger';

chromiumExtra.use(StealthPlugin());

export interface CookieSnapshot {
  name: string;
  cookies: Cookie[];
  savedAt: string;
}

export interface CookieDiff {
  added: Cookie[];
  removed: Cookie[];
  changed: Array<{ name: string; domain: string; path: string; before: string; after: string }>;
}

export interface TokenInventory {
  xoxc: string | null;
  xoxs: string | null;
  xoxb: string | null;
  xoxd: string | null;
  xoxp: string | null;
  bootDataApiToken: string | null;
  otherXoxTokens: string[];
  source: Record<string, string>;
}

export interface NamedContextInfo {
  name: string;
  type: 'default' | 'named';
  pages: Array<{ url: string; title: string }>;
  cookieCount: number;
  createdAt: string;
}

export interface WsFrame {
  direction: 'in' | 'out';
  payload: string;
  truncated?: boolean;
  timestamp: string;
  opcode?: number;
  mask?: boolean;
}

export interface WsConnection {
  id: string;
  url: string;
  initiator?: string;
  startedAt: string;
  handshakeReqHeaders?: Record<string, string>;
  handshakeRespHeaders?: Record<string, string>;
  handshakeStatus?: number;
  closedAt?: string;
  frames: WsFrame[];
}

export interface InterceptRule {
  urlContains?: string;
  urlRegex?: string;
  method?: string;
  direction: 'request' | 'response' | 'both';
}

export interface InterceptedItem {
  id: string;
  phase: 'request' | 'response';
  url: string;
  method: string;
  reqHeaders: Record<string, string>;
  reqBody?: string;
  respStatus?: number;
  respHeaders?: Record<string, string>;
  respBody?: string;
  createdAt: string;
}

export interface AttachNetworkEntry {
  id: string;
  t: string;
  method: string;
  url: string;
  status?: number;
  reqHeaders?: Record<string, string>;
  reqBody?: string;
  respHeaders?: Record<string, string>;
  respCT?: string;
  respBody?: string | null;
  respBodySize?: number;
  failureText?: string;
  durationMs?: number;
}

const NET_CAP = 3000;
const RESP_BODY_MAX = 500_000;
const REQ_BODY_MAX = 100_000;

export interface AttachConfig {
  /** Executable to launch on the user's real display. */
  chromeBin: string;
  /** CDP port Chromium listens on; 9222 is the convention. */
  cdpPort: number;
  /** X display the user is watching. `:0` for the typical Kali desktop. */
  display: string;
  /** Dedicated profile dir so the attached Chrome never touches the user's real profile. */
  userDataDir: string;
  /** How long to wait for Chromium to become ready on the CDP port. */
  startupTimeoutMs: number;
  /** Extra args appended to Chromium invocation. */
  extraArgs: string[];
}

export interface AttachStatus {
  running: boolean;
  cdpPort?: number;
  pid?: number;
  display?: string;
  /** Browser-level CDP endpoint reported by Chromium (includes DevToolsActiveWebSocketUrl). */
  cdpUrl?: string;
}

const DEFAULTS: AttachConfig = {
  chromeBin: '/usr/bin/chromium',
  cdpPort: 9222,
  display: process.env.STEALTH_V2_ATTACH_DISPLAY || ':0',
  userDataDir: '/tmp/rapyd-claude-profile',
  startupTimeoutMs: 15_000,
  // Args picked to make the real-Chrome-on-user-display experience clean:
  //  - start-maximized so the user sees a reasonable window
  //  - no first-run modal, no default-browser prompt
  //  - no synthetic notifications / translate popups
  // DO NOT pass --headless here. The whole point is a visible window.
  extraArgs: [
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,InfinitePrefetch',
    '--disable-infobars',
    '--start-maximized'
  ]
};

/**
 * Manages a headed Chromium instance launched on the user's real X display
 * (`DISPLAY=:0`) and the Playwright CDP attachment to it.
 *
 * Default automation keeps running in the headless browser-manager pool.
 * When Claude needs human input (captcha, MFA, KYB iframe), it calls
 * `attach()` — this spawns a visible Chrome window on Kali's desktop that the
 * human can interact with, while Playwright drives it remotely via CDP for
 * observation, navigation, and cookie sync.
 *
 * This file replaces the old noVNC / Xvfb path owned by `display-manager.ts`.
 */
export class AttachManager {
  private config: AttachConfig;
  private proc: ChildProcess | null = null;
  private browser: Browser | null = null;
  private primaryPage: Page | null = null;
  private ctxHooked: WeakSet<BrowserContext> = new WeakSet();
  private pageHooked: WeakSet<Page> = new WeakSet();
  private netLog: Map<string, AttachNetworkEntry> = new Map();
  private reqStart: Map<string, number> = new Map();
  /** Per-page CDP sessions kept alive for Network domain body-capture (#19 fix). */
  private pageCdp: WeakMap<Page, CDPSession> = new WeakMap();
  /** Named cookie-jar snapshots (in-memory, survives detach/re-attach, not restart). */
  private cookieSnapshots: Map<string, CookieSnapshot> = new Map();
  /** CDP body-capture drain hooks, called when a new netLog entry lands so CDP
   * requestWillBeSent events that arrived before the Playwright entry can claim it.
   * Each registered drainer belongs to one per-page CDP session.
   */
  private pendingDrainers: Set<(url: string) => void> = new Set();
  /** Named extra contexts (#4/#22 — incognito / per-workspace jars). Keyed by caller-supplied name. */
  private namedContexts: Map<string, { ctx: BrowserContext; createdAt: string }> = new Map();
  /** Captured WebSocket connections keyed by CDP requestId (#1/#20). */
  private wsConnections: Map<string, WsConnection> = new Map();
  /** Active intercept rule (single, global across attached context). null = disabled. */
  private interceptRule: InterceptRule | null = null;
  /** Intercepted in-flight requests/responses awaiting user forward/drop/modify. */
  private intercepted: Map<string, { item: InterceptedItem; route: any; resolve: () => void; timer: NodeJS.Timeout }> = new Map();
  /** Route handler installed on context. null if intercept disabled. */
  private interceptHandler: ((route: any) => Promise<void>) | null = null;

  constructor(config: Partial<AttachConfig> = {}) {
    this.config = { ...DEFAULTS, ...config };
  }

  public getStatus(): AttachStatus {
    // "Alive" = Playwright has a live CDP connection. When we reconnect to an
    // existing Chrome (prior server crash, restart, etc.) we never spawn a
    // proc, so requiring proc-alive would wrongly report running=false.
    const alive = !!this.browser?.isConnected();
    const out: AttachStatus = { running: alive };
    if (alive) {
      out.cdpPort = this.config.cdpPort;
      out.display = this.config.display;
      if (this.proc?.pid) out.pid = this.proc.pid;
    }
    return out;
  }

  /**
   * Spawn the visible Chrome on the user's display (if not already running) and
   * connect Playwright to it over CDP. Safe to call repeatedly — returns the
   * existing browser if already attached.
   */
  public async attach(): Promise<{ browser: Browser; context: BrowserContext; page: Page; cdpUrl: string }> {
    // Already have a live Playwright connection? Reuse it — whether we spawned
    // Chrome or reconnected to an existing window. Creating a fresh
    // connectOverCDP on every /v2/attach call piles up duplicate request hooks.
    if (this.browser?.isConnected()) {
      const ctx = this.browser.contexts()[0] ?? await this.browser.newContext();
      this.hookContext(ctx);
      const page = this.pickPrimary(ctx) ?? await ctx.newPage();
      this.primaryPage = page;
      return { browser: this.browser, context: ctx, page, cdpUrl: `http://127.0.0.1:${this.config.cdpPort}` };
    }

    // If Chrome is already running on the CDP port (e.g. server was restarted
    // but the Chrome window is still open), just reconnect without spawning.
    if (await this.isCdpLive()) {
      const cdpUrl = `http://127.0.0.1:${this.config.cdpPort}`;
      Logger.info('AttachManager.attach: reusing existing Chrome on CDP port', { cdpUrl });
      this.browser = await chromiumExtra.connectOverCDP(cdpUrl);
      const ctx = this.browser.contexts()[0] ?? await this.browser.newContext();
      this.hookContext(ctx);
      const page = this.pickPrimary(ctx) ?? await ctx.newPage();
      this.primaryPage = page;
      return { browser: this.browser, context: ctx, page, cdpUrl };
    }

    // Clear stale lock / profile state — a previous unclean shutdown can leave
    // a Singleton* lock inside the profile dir that blocks the next launch.
    await this.cleanProfileLocks();

    Logger.info('AttachManager.attach: spawning Chrome on real display', {
      display: this.config.display,
      port: this.config.cdpPort,
      profile: this.config.userDataDir
    });

    this.proc = this.spawnChrome();
    const cdpUrl = await this.waitForCdp();
    this.browser = await chromiumExtra.connectOverCDP(cdpUrl);

    // Chrome over CDP always hands back at least one default context with an
    // about:blank tab — reuse it so the user sees a single window instead of
    // two.
    const ctx = this.browser.contexts()[0] ?? await this.browser.newContext();
    this.hookContext(ctx);
    const page = this.pickPrimary(ctx) ?? await ctx.newPage();
    this.primaryPage = page;

    Logger.info('AttachManager.attach: Playwright connected', { cdpUrl });
    return { browser: this.browser, context: ctx, page, cdpUrl };
  }

  /**
   * Return the "primary" page — the tab we're driving. Prefers a page on
   * dashboard.rapyd.net-ish host over tracker/ad iframes, falls back to
   * first non-blank tab, then first tab, then a new tab.
   */
  private pickPrimary(ctx: BrowserContext): Page | null {
    const pages = ctx.pages();
    if (!pages.length) return null;
    // Prefer a page that matches the most recent primary URL host, else the first non-blank non-tracker page.
    const nonBlank = pages.filter(p => {
      const u = p.url();
      return u && u !== 'about:blank' && !u.includes('adsrvr') && !u.includes('challenges.cloudflare.com');
    });
    return nonBlank[0] ?? pages[0] ?? null;
  }

  private hookContext(ctx: BrowserContext): void {
    if (this.ctxHooked.has(ctx)) return;
    this.ctxHooked.add(ctx);
    // Hook all current pages
    for (const p of ctx.pages()) this.hookPage(p);
    // Hook future pages
    ctx.on('page', (p) => this.hookPage(p));
  }

  private hookPage(page: Page): void {
    if (this.pageHooked.has(page)) return;
    this.pageHooked.add(page);

    page.on('request', (req: Request) => {
      const id = randomUUID();
      (req as any).__attachId = id;
      this.reqStart.set(id, Date.now());
      let body: string | undefined;
      try {
        const b = req.postData();
        if (b && b.length <= REQ_BODY_MAX) body = b;
      } catch {}
      const entry: AttachNetworkEntry = {
        id,
        t: new Date().toISOString(),
        method: req.method(),
        url: req.url(),
        reqHeaders: req.headers(),
        ...(body ? { reqBody: body } : {})
      };
      this.netLogPush(entry);
    });

    page.on('response', (resp: Response) => {
      try {
        const req = resp.request();
        const id = (req as any).__attachId as string | undefined;
        if (!id) return;
        const entry = this.netLog.get(id);
        if (!entry) return;
        entry.status = resp.status();
        entry.respHeaders = resp.headers();
        const ct = entry.respHeaders['content-type'] || '';
        entry.respCT = ct;
        const start = this.reqStart.get(id);
        if (start) entry.durationMs = Date.now() - start;
        // Body is fetched by the CDP hook on Network.loadingFinished. See
        // setupCdpBodyCapture. The old resp.body() path was unreliable for
        // CDP-attached browsers — Chrome evicts the buffer before Playwright
        // asks for it, so respBody was ~always null.
      } catch (err) {
        Logger.debug('AttachManager response hook error', err);
      }
    });

    page.on('requestfailed', (req: Request) => {
      const id = (req as any).__attachId as string | undefined;
      if (!id) return;
      const entry = this.netLog.get(id);
      if (!entry) return;
      entry.failureText = req.failure()?.errorText || 'failed';
    });

    // #19 fix — kick off CDP body capture in the background. Fire-and-forget
    // so hookPage stays sync (keeps the 'page' event listener contract simple).
    void this.setupCdpBodyCapture(page);
  }

  /**
   * Open a CDP session on `page`, enable Network domain, and harvest response
   * bodies via Network.getResponseBody on loadingFinished. Correlates CDP
   * requestIds to our UUIDs via URL + recency ("most recent entry for this URL
   * that doesn't yet have status / respBody"). Not perfect for repeated
   * polling endpoints but good enough for interactive hunting where URLs are
   * mostly unique inside a short time window.
   */
  private async setupCdpBodyCapture(page: Page): Promise<void> {
    try {
      const client = await page.context().newCDPSession(page);
      this.pageCdp.set(page, client);
      await client.send('Network.enable');

      const cdpToEntry = new Map<string, AttachNetworkEntry>();

      // Playwright's page.on('request') and our CDP Network.requestWillBeSent
      // can race. The Playwright hook creates the netLog entry; we claim it
      // here. But CDP can fire before the Playwright entry exists, or multiple
      // CDP events can fire for same-URL bursts. Handle both:
      //   1. On requestWillBeSent, try to claim the oldest unclaimed entry for
      //      this URL. If none, stash the requestId in a pending bucket.
      //   2. When page.on('request') lands (entry creation), scan the pending
      //      bucket for the oldest CDP request with matching URL and claim.
      const pendingCdpByUrl = new Map<string, string[]>();
      const claimForRequestId = (reqId: string, url: string): boolean => {
        for (const e of this.netLog.values()) {
          if (e.url === url && !e.respHeaders && !(e as any).__cdpClaimed) {
            (e as any).__cdpClaimed = true;
            cdpToEntry.set(reqId, e);
            return true;
          }
        }
        return false;
      };
      client.on('Network.requestWillBeSent', (params: any) => {
        const url = params?.request?.url;
        if (!url || !params.requestId) return;
        if (!claimForRequestId(params.requestId, url)) {
          const arr = pendingCdpByUrl.get(url) ?? [];
          arr.push(params.requestId);
          pendingCdpByUrl.set(url, arr);
        }
      });
      // Drain the pending bucket whenever a new entry appears for a URL.
      this.pendingDrainers.add((url: string) => {
        const arr = pendingCdpByUrl.get(url);
        if (!arr?.length) return;
        const reqId = arr.shift()!;
        if (!arr.length) pendingCdpByUrl.delete(url); else pendingCdpByUrl.set(url, arr);
        claimForRequestId(reqId, url);
      });

      client.on('Network.loadingFinished', async (params: any) => {
        const entry = cdpToEntry.get(params.requestId);
        cdpToEntry.delete(params.requestId);
        if (!entry) return;
        // Only capture text-ish bodies to avoid blobs eating memory.
        const ct = (entry.respCT || entry.respHeaders?.['content-type'] || '').toLowerCase();
        const isText = ct.includes('json')
          || ct.startsWith('text/')
          || ct.includes('urlencoded')
          || ct.includes('javascript')
          || ct.includes('xml')
          || ct.includes('graphql');
        if (!isText) {
          // Record size but not body for non-text.
          if (typeof params.encodedDataLength === 'number') entry.respBodySize = params.encodedDataLength;
          entry.respBody = null;
          return;
        }
        try {
          const result: any = await client.send('Network.getResponseBody', { requestId: params.requestId });
          const raw: string = result.base64Encoded
            ? Buffer.from(result.body, 'base64').toString('utf8')
            : result.body;
          entry.respBodySize = raw.length;
          entry.respBody = raw.length <= RESP_BODY_MAX ? raw : null;
        } catch (err) {
          // Body already evicted or request type doesn't expose body (redirects).
          entry.respBody = null;
        }
      });

      client.on('Network.loadingFailed', (params: any) => {
        cdpToEntry.delete(params.requestId);
      });

      // #1/#20 — WebSocket capture on the same CDP session.
      await this.setupWsCapture(page, client);

      // If the page closes, drop the CDP session.
      page.once('close', () => {
        cdpToEntry.clear();
        try { void client.detach(); } catch { /* ignore */ }
      });
    } catch (err) {
      Logger.error('AttachManager.setupCdpBodyCapture failed', err);
    }
  }

  private netLogPush(entry: AttachNetworkEntry): void {
    this.netLog.set(entry.id, entry);
    // Let any waiting CDP sessions claim this entry for their pending requestIds.
    for (const drain of this.pendingDrainers) { try { drain(entry.url); } catch {} }
    if (this.netLog.size > NET_CAP) {
      const firstKey = this.netLog.keys().next().value;
      if (firstKey) {
        this.netLog.delete(firstKey);
        this.reqStart.delete(firstKey);
      }
    }
  }

  // ---------------- Driver API ----------------

  private async getPrimary(): Promise<Page> {
    if (!this.browser?.isConnected()) throw new Error('not attached — call attach() first');
    if (this.primaryPage && !this.primaryPage.isClosed()) return this.primaryPage;
    const ctx = this.browser.contexts()[0];
    if (!ctx) throw new Error('no context on attached browser');
    const p = this.pickPrimary(ctx) ?? await ctx.newPage();
    this.primaryPage = p;
    return p;
  }

  /** Change which tab is "primary" by matching URL substring. */
  public async selectTab(urlSubstr: string): Promise<{ url: string; title: string }> {
    if (!this.browser?.isConnected()) throw new Error('not attached');
    const ctx = this.browser.contexts()[0];
    if (!ctx) throw new Error('no context');
    const match = ctx.pages().find(p => p.url().includes(urlSubstr));
    if (!match) throw new Error(`no tab matching "${urlSubstr}"`);
    this.primaryPage = match;
    await match.bringToFront().catch(() => {});
    return { url: match.url(), title: await match.title().catch(() => '') };
  }

  public async listTabs(): Promise<Array<{ index: number; url: string; title: string; primary: boolean }>> {
    if (!this.browser?.isConnected()) throw new Error('not attached');
    const ctx = this.browser.contexts()[0];
    if (!ctx) return [];
    const out: Array<{ index: number; url: string; title: string; primary: boolean }> = [];
    const pages = ctx.pages();
    for (let i = 0; i < pages.length; i++) {
      const p = pages[i];
      if (!p) continue;
      out.push({
        index: i,
        url: p.url(),
        title: await p.title().catch(() => ''),
        primary: p === this.primaryPage
      });
    }
    return out;
  }

  public async navigate(url: string): Promise<{ url: string; title: string }> {
    const page = await this.getPrimary();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    return { url: page.url(), title: await page.title().catch(() => '') };
  }

  public async eval(script: string, arg?: unknown): Promise<unknown> {
    const page = await this.getPrimary();
    // Build a real function so Playwright serializes it by source. Treat
    // script as a block body if it contains `return`, else as an expression.
    const fnBody = script.includes('return') ? script : `return (${script});`;
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const fn = new Function('__arg', fnBody) as (arg: unknown) => unknown;
    return await page.evaluate(fn, arg);
  }

  public async type(selector: string, text: string, opts: { delay?: number; clear?: boolean } = {}): Promise<void> {
    const page = await this.getPrimary();
    const el = await page.waitForSelector(selector, { timeout: 10_000 });
    if (!el) throw new Error(`selector not found: ${selector}`);
    if (opts.clear !== false) await el.click({ clickCount: 3 });
    await el.type(text, { delay: opts.delay ?? 30 });
  }

  public async click(selector: string): Promise<void> {
    const page = await this.getPrimary();
    const el = await page.waitForSelector(selector, { timeout: 10_000 });
    if (!el) throw new Error(`selector not found: ${selector}`);
    await el.click();
  }

  /** Focus an element then send real keystrokes via CDP Input domain. */
  public async keyboardType(selector: string | null, text: string, delay = 40): Promise<void> {
    const page = await this.getPrimary();
    if (selector) {
      const el = await page.waitForSelector(selector, { timeout: 10_000 });
      if (!el) throw new Error(`selector not found: ${selector}`);
      await el.focus();
    }
    await page.keyboard.type(text, { delay });
  }

  /** Click the first element whose innerText matches (substring). */
  public async clickText(text: string): Promise<void> {
    const page = await this.getPrimary();
    // Use Playwright's text locator for a proper hit-test click.
    await page.locator(`text=${text}`).first().click({ timeout: 10_000 });
  }

  public async pageText(limit = 8000): Promise<{ url: string; title: string; text: string }> {
    const page = await this.getPrimary();
    const text = await page.evaluate((n: number) => (document.body?.innerText || '').slice(0, n), limit);
    return { url: page.url(), title: await page.title().catch(() => ''), text };
  }

  public async snapshotForm(): Promise<any> {
    const page = await this.getPrimary();
    return await page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('input, textarea, select')).map((el: any) => ({
        tag: el.tagName.toLowerCase(),
        name: el.name, id: el.id, type: el.type,
        placeholder: el.placeholder, valLen: (el.value || '').length,
        visible: el.offsetParent !== null,
        disabled: !!el.disabled
      }));
      const buttons = Array.from(document.querySelectorAll('button, [role=button]')).map((b: any) => ({
        text: (b.textContent || '').trim().slice(0, 80),
        type: b.type, disabled: !!b.disabled,
        visible: b.offsetParent !== null
      }));
      return { url: location.href, inputs, buttons };
    });
  }

  /** Query captured network entries — metadata only (no bodies). */
  public queryNetwork(opts: {
    filter?: string;
    method?: string;
    status?: number;
    since?: string;
    limit?: number;
  } = {}): Array<Omit<AttachNetworkEntry, 'reqBody' | 'respBody'> & { hasReqBody: boolean; hasRespBody: boolean }> {
    const limit = opts.limit ?? 100;
    const sinceT = opts.since ? Date.parse(opts.since) : 0;
    const out: Array<any> = [];
    for (const e of this.netLog.values()) {
      if (opts.filter && !e.url.includes(opts.filter)) continue;
      if (opts.method && e.method.toUpperCase() !== opts.method.toUpperCase()) continue;
      if (opts.status != null && e.status !== opts.status) continue;
      if (sinceT && Date.parse(e.t) < sinceT) continue;
      const { reqBody, respBody, ...rest } = e;
      out.push({ ...rest, hasReqBody: !!reqBody, hasRespBody: !!respBody });
      if (out.length >= limit) break;
    }
    return out;
  }

  public getNetworkEntry(id: string): AttachNetworkEntry | null {
    return this.netLog.get(id) ?? null;
  }

  public clearNetwork(): number {
    const n = this.netLog.size;
    this.netLog.clear();
    this.reqStart.clear();
    return n;
  }

  // ---------------- Cookies (#16, #17, #18) ----------------

  /** Read cookies from the attached Chrome. Returns HttpOnly cookies too. */
  public async getCookies(filters: { domain?: string; name?: string } = {}): Promise<Cookie[]> {
    if (!this.browser?.isConnected()) throw new Error('not attached — call attach() first');
    const ctx = this.browser.contexts()[0];
    if (!ctx) throw new Error('no context');
    const all = await ctx.cookies();
    const domainF = filters.domain?.toLowerCase();
    return all.filter(c => {
      if (domainF && !c.domain.toLowerCase().includes(domainF)) return false;
      if (filters.name && c.name !== filters.name) return false;
      return true;
    });
  }

  /**
   * Delete cookies from the attached Chrome matching filters. Filters are
   * ANDed. At least one filter must be non-empty (accidental whole-jar wipe
   * would be a bad primitive; use reset() for that).
   */
  public async deleteCookies(filters: { domain?: string; name?: string; path?: string }): Promise<{ deleted: number }> {
    if (!this.browser?.isConnected()) throw new Error('not attached — call attach() first');
    if (!filters.domain && !filters.name && !filters.path) {
      throw new Error('deleteCookies requires at least one of {domain, name, path}');
    }
    const ctx = this.browser.contexts()[0];
    if (!ctx) throw new Error('no context');
    const all = await ctx.cookies();
    const domainF = filters.domain?.toLowerCase();
    const matches = all.filter(c => {
      if (domainF && !c.domain.toLowerCase().includes(domainF)) return false;
      if (filters.name && c.name !== filters.name) return false;
      if (filters.path && c.path !== filters.path) return false;
      return true;
    });
    if (!matches.length) return { deleted: 0 };

    // Use browser-level CDP for Network.deleteCookies. Requires a BrowserContext
    // CDP session in newer Playwright; fall back to page-level session.
    const page = await this.getPrimary();
    const client = await ctx.newCDPSession(page);
    let deleted = 0;
    for (const c of matches) {
      try {
        await client.send('Network.deleteCookies', {
          name: c.name,
          domain: c.domain,
          path: c.path
        });
        deleted++;
      } catch (err) {
        Logger.error(`deleteCookies failed for ${c.name}@${c.domain}${c.path}`, err);
      }
    }
    try { await client.detach(); } catch { /* ignore */ }
    return { deleted };
  }

  /** Save current cookie jar under `name`. Overwrites existing snapshot. */
  public async snapshotCookies(name: string): Promise<{ name: string; count: number; savedAt: string }> {
    if (!this.browser?.isConnected()) throw new Error('not attached — call attach() first');
    const ctx = this.browser.contexts()[0];
    if (!ctx) throw new Error('no context');
    const cookies = await ctx.cookies();
    const savedAt = new Date().toISOString();
    this.cookieSnapshots.set(name, { name, cookies, savedAt });
    return { name, count: cookies.length, savedAt };
  }

  /** List named snapshots (metadata only). */
  public listCookieSnapshots(): Array<{ name: string; count: number; savedAt: string }> {
    return Array.from(this.cookieSnapshots.values()).map(s => ({
      name: s.name, count: s.cookies.length, savedAt: s.savedAt
    }));
  }

  /**
   * Diff two snapshots. If `after === 'current'` (default), diffs against the
   * live jar. Match key is name+domain+path (RFC 6265 uniqueness).
   */
  public async diffCookieSnapshots(before: string, after: string = 'current'): Promise<CookieDiff> {
    const beforeSnap = this.cookieSnapshots.get(before);
    if (!beforeSnap) throw new Error(`snapshot not found: ${before}`);

    let afterCookies: Cookie[];
    if (after === 'current') {
      if (!this.browser?.isConnected()) throw new Error('not attached');
      const ctx = this.browser.contexts()[0];
      if (!ctx) throw new Error('no context');
      afterCookies = await ctx.cookies();
    } else {
      const afterSnap = this.cookieSnapshots.get(after);
      if (!afterSnap) throw new Error(`snapshot not found: ${after}`);
      afterCookies = afterSnap.cookies;
    }

    const key = (c: Cookie) => `${c.name} ${c.domain} ${c.path}`;
    const beforeMap = new Map(beforeSnap.cookies.map(c => [key(c), c]));
    const afterMap = new Map(afterCookies.map(c => [key(c), c]));

    const added: Cookie[] = [];
    const removed: Cookie[] = [];
    const changed: CookieDiff['changed'] = [];

    for (const [k, c] of afterMap) {
      const prev = beforeMap.get(k);
      if (!prev) added.push(c);
      else if (prev.value !== c.value) {
        changed.push({ name: c.name, domain: c.domain, path: c.path, before: prev.value, after: c.value });
      }
    }
    for (const [k, c] of beforeMap) {
      if (!afterMap.has(k)) removed.push(c);
    }

    return { added, removed, changed };
  }

  // ---------------- Waits (#21) ----------------

  /** Wait until the primary tab contains `text` or matches `selector`. */
  public async waitFor(
    target: { text?: string; selector?: string },
    timeoutMs: number = 10_000
  ): Promise<{ matched: 'text' | 'selector'; elapsedMs: number }> {
    const page = await this.getPrimary();
    const start = Date.now();
    if (target.selector && target.text) {
      throw new Error('waitFor: provide exactly one of {text, selector}');
    }
    if (target.selector) {
      await page.waitForSelector(target.selector, { timeout: timeoutMs });
      return { matched: 'selector', elapsedMs: Date.now() - start };
    }
    if (target.text) {
      const needle = target.text;
      await page.waitForFunction(
        (n: string) => !!document.body && document.body.innerText.includes(n),
        needle,
        { timeout: timeoutMs }
      );
      return { matched: 'text', elapsedMs: Date.now() - start };
    }
    throw new Error('waitFor: provide {text} or {selector}');
  }

  // ---------------- Visual capture (#24, #7) ----------------

  /**
   * Screenshot the primary tab (or a selector). `path` writes to disk; `returnBase64`
   * controls whether the PNG bytes are echoed back inline (a fullPage PNG is ~100KB+
   * which overflows MCP tool-result budgets). Default: inline base64 only when no
   * path is given; setting `returnBase64: true` forces inline even with a path,
   * `returnBase64: false` suppresses it even without a path.
   */
  public async screenshot(opts: { fullPage?: boolean; path?: string; selector?: string; returnBase64?: boolean } = {}): Promise<{ base64?: string; path?: string; bytes: number }> {
    const page = await this.getPrimary();
    let buf: Buffer;
    if (opts.selector) {
      const loc = page.locator(opts.selector).first();
      buf = await loc.screenshot({ type: 'png' });
    } else {
      buf = await page.screenshot({ type: 'png', fullPage: !!opts.fullPage });
    }
    let diskPath: string | undefined;
    if (opts.path) {
      await fs.writeFile(opts.path, buf);
      diskPath = opts.path;
    }
    const inline = opts.returnBase64 === undefined ? !diskPath : opts.returnBase64;
    const out: { base64?: string; path?: string; bytes: number } = { bytes: buf.length };
    if (inline) out.base64 = buf.toString('base64');
    if (diskPath) out.path = diskPath;
    return out;
  }

  /** Full HTML snapshot of the primary tab. Returns the HTML + optional disk path. */
  public async domSnapshot(path?: string): Promise<{ html: string; path?: string; bytes: number }> {
    const page = await this.getPrimary();
    const html = await page.content();
    const bytes = Buffer.byteLength(html, 'utf8');
    let diskPath: string | undefined;
    if (path) {
      await fs.writeFile(path, html, 'utf8');
      diskPath = path;
    }
    const out: { html: string; path?: string; bytes: number } = { html, bytes };
    if (diskPath) out.path = diskPath;
    return out;
  }

  // ---------------- Token extraction (#5) ----------------

  /** Scrape Slack xox* tokens from localStorage, window globals, and page source. */
  public async extractTokens(): Promise<TokenInventory> {
    const page = await this.getPrimary();
    const raw = await page.evaluate(() => {
      const result: any = {
        bootDataApiToken: null,
        localStorage: {} as Record<string, any>,
        windowBoot: null as any,
        cookieString: document.cookie,
        html: document.documentElement.outerHTML
      };
      try {
        const bd = localStorage.getItem('boot_data');
        if (bd) {
          result.localStorage['boot_data'] = bd;
          try {
            const parsed = JSON.parse(bd);
            if (parsed && typeof parsed.api_token === 'string') {
              result.bootDataApiToken = parsed.api_token;
            }
          } catch { /* non-JSON */ }
        }
        const lc = localStorage.getItem('localConfig_v2');
        if (lc) result.localStorage['localConfig_v2'] = lc;
      } catch { /* access blocked */ }
      try {
        if ((window as any).boot_data) {
          result.windowBoot = (window as any).boot_data?.api_token || null;
        }
      } catch { /* cross-origin */ }
      return result;
    });

    const inv: TokenInventory = {
      xoxc: null, xoxs: null, xoxb: null, xoxd: null, xoxp: null,
      bootDataApiToken: null,
      otherXoxTokens: [],
      source: {}
    };
    if (typeof raw.bootDataApiToken === 'string') {
      inv.bootDataApiToken = raw.bootDataApiToken;
      inv.source.bootDataApiToken = 'localStorage.boot_data.api_token';
    }
    if (typeof raw.windowBoot === 'string') {
      inv.source.windowBoot = 'window.boot_data.api_token';
    }

    // Regex-scan all the text we grabbed for xox* tokens.
    const haystacks: Array<{ text: string; where: string }> = [
      { text: raw.html || '', where: 'page_html' },
      { text: raw.cookieString || '', where: 'document.cookie' }
    ];
    for (const [k, v] of Object.entries(raw.localStorage || {})) {
      haystacks.push({ text: String(v), where: `localStorage.${k}` });
    }

    const xoxRe = /xox[bcspdoar]-[a-zA-Z0-9-]{10,}/g;
    const seen = new Set<string>();
    for (const h of haystacks) {
      const m = h.text.match(xoxRe);
      if (!m) continue;
      for (const tok of m) {
        if (seen.has(tok)) continue;
        seen.add(tok);
        const prefix = tok.slice(0, 4) as 'xoxc' | 'xoxs' | 'xoxb' | 'xoxd' | 'xoxp';
        if (prefix === 'xoxc' || prefix === 'xoxs' || prefix === 'xoxb' || prefix === 'xoxd' || prefix === 'xoxp') {
          if (!inv[prefix]) {
            inv[prefix] = tok;
            inv.source[prefix] = h.where;
          } else if (inv[prefix] !== tok) {
            inv.otherXoxTokens.push(tok);
          }
        } else {
          inv.otherXoxTokens.push(tok);
        }
      }
    }
    return inv;
  }

  // ---------------- HAR export (#6) ----------------

  /** Build a HAR 1.2 document from the attached-tab network log. */
  public toHAR(): object {
    const entries = [];
    for (const e of this.netLog.values()) {
      entries.push({
        startedDateTime: e.t,
        time: e.durationMs ?? 0,
        request: {
          method: e.method,
          url: e.url,
          httpVersion: 'HTTP/2',
          cookies: [] as any[],
          headers: Object.entries(e.reqHeaders || {}).map(([name, value]) => ({ name, value })),
          queryString: safeQuery(e.url),
          postData: e.reqBody
            ? { mimeType: e.reqHeaders?.['content-type'] || 'text/plain', text: e.reqBody }
            : undefined,
          headersSize: -1,
          bodySize: e.reqBody ? Buffer.byteLength(e.reqBody, 'utf8') : -1
        },
        response: {
          status: e.status ?? 0,
          statusText: '',
          httpVersion: 'HTTP/2',
          cookies: [] as any[],
          headers: Object.entries(e.respHeaders || {}).map(([name, value]) => ({ name, value })),
          content: {
            size: e.respBodySize ?? -1,
            mimeType: e.respCT || 'application/octet-stream',
            text: e.respBody ?? undefined
          },
          redirectURL: '',
          headersSize: -1,
          bodySize: e.respBodySize ?? -1
        },
        cache: {},
        timings: { send: 0, wait: e.durationMs ?? 0, receive: 0 }
      });
    }
    return {
      log: {
        version: '1.2',
        creator: { name: 'stealth-browser-v2-attach', version: '2.0.0' },
        pages: [],
        entries
      }
    };
  }

  /**
   * Disconnect Playwright and kill the Chrome window. Does not wipe the
   * profile — cookies persist across attach cycles until `reset()`.
   */
  public async detach(): Promise<void> {
    if (this.browser) {
      try { await this.browser.close(); } catch { /* may already be disconnected */ }
      this.browser = null;
    }
    if (this.proc) {
      try { this.proc.kill('SIGTERM'); } catch {}
      // Follow up with SIGKILL if Chrome is stubborn.
      const stubborn = this.proc;
      setTimeout(() => { try { stubborn.kill('SIGKILL'); } catch {} }, 2000);
      this.proc = null;
    }
  }

  /**
   * Nuke the profile dir so the next attach starts clean (no prior cookies).
   */
  public async reset(): Promise<void> {
    await this.detach();
    try {
      await fs.rm(this.config.userDataDir, { recursive: true, force: true });
    } catch (err) {
      Logger.error('AttachManager.reset: failed to remove profile dir', err);
    }
  }

  public async shutdown(): Promise<void> {
    await this.detach();
  }

  // ============================================================
  // #4 / #22 — Named / incognito contexts
  // ============================================================

  /**
   * Create a new BrowserContext with its own cookie jar and open a blank page in
   * it. In attached Chrome, the new context surfaces as a separate window. Name
   * is caller-chosen; must not collide with an existing named context or the
   * reserved 'default' name.
   */
  public async createContext(name: string): Promise<NamedContextInfo> {
    if (!this.browser?.isConnected()) throw new Error('not attached');
    if (name === 'default') throw new Error('"default" is reserved for the attached context');
    if (this.namedContexts.has(name)) throw new Error(`context "${name}" already exists`);
    const ctx = await this.browser.newContext();
    this.namedContexts.set(name, { ctx, createdAt: new Date().toISOString() });
    // Hook for network capture parity with the default context.
    this.hookContext(ctx);
    // Open a page so the context surfaces in Chrome.
    const page = await ctx.newPage();
    try { await page.goto('about:blank'); } catch {}
    return this.describeContext(name);
  }

  /** Look up a named context (throws if missing). 'default' maps to contexts()[0]. */
  private resolveContext(name: string): BrowserContext {
    if (!this.browser?.isConnected()) throw new Error('not attached');
    if (name === 'default') {
      const ctx = this.browser.contexts()[0];
      if (!ctx) throw new Error('no default context on attached browser');
      return ctx;
    }
    const entry = this.namedContexts.get(name);
    if (!entry) throw new Error(`context "${name}" not found`);
    return entry.ctx;
  }

  private async describeContext(name: string): Promise<NamedContextInfo> {
    const ctx = this.resolveContext(name);
    const pagesInfo = await Promise.all(ctx.pages().map(async (p) => ({
      url: p.url(),
      title: await p.title().catch(() => '')
    })));
    const cookies = await ctx.cookies();
    const entry = this.namedContexts.get(name);
    return {
      name,
      type: name === 'default' ? 'default' : 'named',
      pages: pagesInfo,
      cookieCount: cookies.length,
      createdAt: entry?.createdAt ?? new Date(0).toISOString()
    };
  }

  public async listContexts(): Promise<NamedContextInfo[]> {
    if (!this.browser?.isConnected()) throw new Error('not attached');
    const out: NamedContextInfo[] = [];
    out.push(await this.describeContext('default'));
    for (const name of this.namedContexts.keys()) {
      out.push(await this.describeContext(name));
    }
    return out;
  }

  public async closeContext(name: string): Promise<void> {
    if (name === 'default') throw new Error('cannot close the default context; use detach() to end attach');
    const entry = this.namedContexts.get(name);
    if (!entry) throw new Error(`context "${name}" not found`);
    try { await entry.ctx.close(); } catch {}
    this.namedContexts.delete(name);
  }

  /** Navigate within a named context's first page (creates one if none). */
  public async navigateContext(name: string, url: string, opts: { waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' | 'commit'; timeout?: number } = {}): Promise<{ url: string; title: string }> {
    const ctx = this.resolveContext(name);
    const page = ctx.pages()[0] ?? await ctx.newPage();
    await page.goto(url, { waitUntil: opts.waitUntil ?? 'domcontentloaded', timeout: opts.timeout ?? 30_000 });
    return { url: page.url(), title: await page.title().catch(() => '') };
  }

  /** Get cookies for a named context, with the same filters as getCookies. */
  public async getContextCookies(name: string, filters: { domain?: string; name?: string } = {}): Promise<Cookie[]> {
    const ctx = this.resolveContext(name);
    let cookies = await ctx.cookies();
    if (filters.domain) {
      const d = filters.domain.toLowerCase();
      cookies = cookies.filter(c => (c.domain || '').toLowerCase() === d || (c.domain || '').toLowerCase().endsWith('.' + d) || d.endsWith('.' + (c.domain || '').replace(/^\./, '').toLowerCase()));
    }
    if (filters.name) {
      const n = filters.name;
      cookies = cookies.filter(c => c.name === n);
    }
    return cookies;
  }

  // ============================================================
  // #2 — Env cookie loader
  // ============================================================

  /**
   * Load cookies from a file into a target context. Supports:
   *   - JSON: top-level array of Cookie objects, or { cookies: [...] }
   *   - Env-style: lines of `name=value`, with optional `# domain=...`,
   *     `# path=...`, `# secure`, `# httpOnly`, `# sameSite=Lax` header
   *     directives that apply to every cookie below (until overridden by
   *     another header). Lines starting with `#` that do not contain `=` and
   *     aren't known directives are treated as comments.
   * Returns the number of cookies added.
   */
  public async loadCookiesFromFile(path: string, contextName: string = 'default'): Promise<{ added: number; source: 'json' | 'env' }> {
    const raw = await fs.readFile(path, 'utf8');
    const ctx = this.resolveContext(contextName);
    let cookies: Array<any>;
    let source: 'json' | 'env';
    const trimmed = raw.trimStart();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      const parsed = JSON.parse(raw);
      cookies = Array.isArray(parsed) ? parsed : (parsed.cookies ?? []);
      source = 'json';
    } else {
      cookies = this.parseEnvCookies(raw);
      source = 'env';
    }
    if (!cookies.length) return { added: 0, source };
    await ctx.addCookies(cookies as any);
    return { added: cookies.length, source };
  }

  private parseEnvCookies(text: string): Array<any> {
    const headers: Record<string, string | boolean> = { path: '/' };
    const out: Array<any> = [];
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      if (line.startsWith('#')) {
        const body = line.slice(1).trim();
        const m = body.match(/^(domain|path|sameSite)\s*=\s*(.+)$/i);
        if (m && m[1] && m[2] !== undefined) { headers[m[1].toLowerCase()] = m[2].trim(); continue; }
        if (/^(secure|httpOnly)$/i.test(body)) { headers[body.toLowerCase() === 'httponly' ? 'httpOnly' : 'secure'] = true; continue; }
        // plain comment
        continue;
      }
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const name = line.slice(0, eq).trim();
      const value = line.slice(eq + 1).trim();
      if (!name) continue;
      if (!headers.domain) throw new Error('cookie env file: need `# domain=...` directive before cookies');
      const c: any = { name, value, domain: String(headers.domain), path: String(headers.path || '/') };
      if (headers.secure === true) c.secure = true;
      if (headers.httpOnly === true) c.httpOnly = true;
      if (headers.sameSite) c.sameSite = String(headers.sameSite);
      out.push(c);
    }
    return out;
  }

  /** Serialize current-context cookies to env format (filtered to domain). */
  public async exportCookiesToEnv(contextName: string, domain: string): Promise<string> {
    const ctx = this.resolveContext(contextName);
    const cookies = await ctx.cookies();
    const d = domain.toLowerCase();
    const matched = cookies.filter(c => {
      const cd = (c.domain || '').toLowerCase();
      return cd === d || cd === ('.' + d) || cd.endsWith('.' + d) || d.endsWith('.' + cd.replace(/^\./, ''));
    });
    const lines: string[] = [`# domain=${domain}`, `# path=/`];
    if (matched.some(c => c.secure)) lines.push('# secure');
    if (matched.some(c => c.httpOnly)) lines.push('# httpOnly');
    for (const c of matched) lines.push(`${c.name}=${c.value}`);
    return lines.join('\n') + '\n';
  }

  // ============================================================
  // #1 / #20 — WebSocket capture + send
  // ============================================================

  /** List captured WebSocket connections (without frame payloads). */
  public listWebSockets(): Array<Omit<WsConnection, 'frames'> & { frameCount: number }> {
    const out: Array<Omit<WsConnection, 'frames'> & { frameCount: number }> = [];
    for (const ws of this.wsConnections.values()) {
      const { frames, ...rest } = ws;
      out.push({ ...rest, frameCount: frames.length });
    }
    return out;
  }

  /** Get full connection detail (headers, all frames). */
  public getWebSocket(id: string): WsConnection | null {
    return this.wsConnections.get(id) ?? null;
  }

  /** Query frames across all connections. */
  public queryWsFrames(opts: { connectionId?: string; direction?: 'in' | 'out'; contains?: string; limit?: number } = {}): Array<WsFrame & { connectionId: string; url: string }> {
    const limit = opts.limit ?? 500;
    const contains = opts.contains?.toLowerCase();
    const out: Array<WsFrame & { connectionId: string; url: string }> = [];
    for (const ws of this.wsConnections.values()) {
      if (opts.connectionId && ws.id !== opts.connectionId) continue;
      for (const f of ws.frames) {
        if (opts.direction && f.direction !== opts.direction) continue;
        if (contains && !f.payload.toLowerCase().includes(contains)) continue;
        out.push({ ...f, connectionId: ws.id, url: ws.url });
        if (out.length >= limit) return out;
      }
    }
    return out;
  }

  /**
   * Send a frame on an existing WebSocket by URL match. Works by evaluating JS
   * in the page: the page had to open that WebSocket itself — if a different
   * page owns it this will no-op. The payload is sent verbatim (string).
   */
  public async sendWsFrame(urlContains: string, payload: string, contextName: string = 'default'): Promise<{ sentOnPages: number }> {
    const ctx = this.resolveContext(contextName);
    let sent = 0;
    for (const page of ctx.pages()) {
      try {
        const delivered = await page.evaluate(([needle, body]) => {
          // window.__sbWsRegistry is installed by the WS constructor hook
          // in setupCdpWsCapture's init script.
          const reg: any[] = (window as any).__sbWsRegistry || [];
          let ok = 0;
          for (const ws of reg) {
            try {
              if (ws && ws.readyState === 1 && (ws.url || '').indexOf(needle) !== -1) {
                ws.send(body);
                ok++;
              }
            } catch {}
          }
          return ok;
        }, [urlContains, payload] as const);
        sent += delivered || 0;
      } catch {}
    }
    return { sentOnPages: sent };
  }

  private async setupWsCapture(page: Page, client: CDPSession): Promise<void> {
    // CDP-side: capture frames and handshake headers.
    client.on('Network.webSocketCreated', (params: any) => {
      if (!params?.requestId) return;
      this.wsConnections.set(params.requestId, {
        id: params.requestId,
        url: params.url,
        initiator: params.initiator?.type,
        startedAt: new Date().toISOString(),
        frames: []
      });
    });
    client.on('Network.webSocketWillSendHandshakeRequest', (params: any) => {
      const ws = this.wsConnections.get(params.requestId);
      if (!ws) return;
      ws.handshakeReqHeaders = params.request?.headers;
    });
    client.on('Network.webSocketHandshakeResponseReceived', (params: any) => {
      const ws = this.wsConnections.get(params.requestId);
      if (!ws) return;
      ws.handshakeRespHeaders = params.response?.headers;
      ws.handshakeStatus = params.response?.status;
    });
    const captureFrame = (direction: 'in' | 'out') => (params: any) => {
      const ws = this.wsConnections.get(params.requestId);
      if (!ws) return;
      const payload: string = params.response?.payloadData ?? '';
      const cap = 100_000;
      ws.frames.push({
        direction,
        payload: payload.length > cap ? payload.slice(0, cap) : payload,
        truncated: payload.length > cap ? true : undefined,
        timestamp: new Date().toISOString(),
        opcode: params.response?.opcode,
        mask: params.response?.mask
      } as WsFrame);
      const FRAME_CAP = 2000;
      if (ws.frames.length > FRAME_CAP) ws.frames.splice(0, ws.frames.length - FRAME_CAP);
    };
    client.on('Network.webSocketFrameReceived', captureFrame('in'));
    client.on('Network.webSocketFrameSent', captureFrame('out'));
    client.on('Network.webSocketClosed', (params: any) => {
      const ws = this.wsConnections.get(params.requestId);
      if (!ws) return;
      ws.closedAt = new Date().toISOString();
    });
    // Page-side: register every WebSocket in a window array so we can inject frames later.
    try {
      await page.addInitScript(() => {
        const OrigWS = (window as any).WebSocket;
        const registry: any[] = [];
        (window as any).__sbWsRegistry = registry;
        (window as any).WebSocket = function(url: string, protocols?: any) {
          const w = new OrigWS(url, protocols);
          try { registry.push(w); } catch {}
          return w;
        } as any;
        (window as any).WebSocket.prototype = OrigWS.prototype;
      });
    } catch {}
  }

  // ============================================================
  // #3 / #23 — Request + response intercept
  // ============================================================

  public async enableIntercept(rule: InterceptRule): Promise<void> {
    if (!this.browser?.isConnected()) throw new Error('not attached');
    this.interceptRule = rule;
    const ctx = this.browser.contexts()[0];
    if (!ctx) throw new Error('no default context');
    // Uninstall previous handler if any.
    if (this.interceptHandler) {
      try { await ctx.unroute('**/*', this.interceptHandler); } catch {}
      this.interceptHandler = null;
    }
    const urlRegex = rule.urlRegex ? new RegExp(rule.urlRegex) : null;
    const matches = (url: string, method: string): boolean => {
      if (rule.method && method.toUpperCase() !== rule.method.toUpperCase()) return false;
      if (rule.urlContains && !url.includes(rule.urlContains)) return false;
      if (urlRegex && !urlRegex.test(url)) return false;
      return true;
    };
    const handler = async (route: any) => {
      const req = route.request();
      if (!matches(req.url(), req.method())) { try { await route.continue(); } catch {} return; }
      if (rule.direction === 'request' || rule.direction === 'both') {
        await this.pauseAtPhase('request', route, req);
        if (rule.direction === 'request') return; // already forwarded/dropped by caller
      }
      // Response phase: fetch, then pause on result.
      if (rule.direction === 'response' || rule.direction === 'both') {
        try {
          const resp = await route.fetch();
          const body = await resp.text().catch(() => '');
          await this.pauseAtPhase('response', route, req, { status: resp.status(), headers: resp.headers(), body });
        } catch (err) {
          try { await route.abort(); } catch {}
        }
      }
    };
    this.interceptHandler = handler;
    await ctx.route('**/*', handler);
  }

  private async pauseAtPhase(phase: 'request' | 'response', route: any, req: any, resp?: { status: number; headers: Record<string, string>; body: string }): Promise<void> {
    const id = randomUUID();
    const item: InterceptedItem = {
      id,
      phase,
      url: req.url(),
      method: req.method(),
      reqHeaders: req.headers(),
      reqBody: (() => { try { return req.postData() ?? undefined; } catch { return undefined; } })(),
      createdAt: new Date().toISOString(),
      ...(resp ? { respStatus: resp.status, respHeaders: resp.headers, respBody: resp.body } : {})
    };
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        // Auto-forward on timeout so the app doesn't hang forever.
        try { void route.continue(); } catch {}
        this.intercepted.delete(id);
        resolve();
      }, 60_000);
      this.intercepted.set(id, { item, route, resolve, timer });
    });
  }

  public listIntercepted(): InterceptedItem[] {
    return Array.from(this.intercepted.values()).map(x => x.item);
  }

  public async forwardIntercepted(id: string, modify: { method?: string; url?: string; headers?: Record<string, string>; body?: string; status?: number } = {}): Promise<void> {
    const entry = this.intercepted.get(id);
    if (!entry) throw new Error(`no intercepted item with id ${id}`);
    clearTimeout(entry.timer);
    this.intercepted.delete(id);
    try {
      if (entry.item.phase === 'request') {
        await entry.route.continue({
          ...(modify.method ? { method: modify.method } : {}),
          ...(modify.url ? { url: modify.url } : {}),
          ...(modify.headers ? { headers: modify.headers } : {}),
          ...(modify.body != null ? { postData: modify.body } : {})
        });
      } else {
        await entry.route.fulfill({
          status: modify.status ?? entry.item.respStatus ?? 200,
          headers: modify.headers ?? entry.item.respHeaders ?? {},
          body: modify.body ?? entry.item.respBody ?? ''
        });
      }
    } finally {
      entry.resolve();
    }
  }

  public async dropIntercepted(id: string): Promise<void> {
    const entry = this.intercepted.get(id);
    if (!entry) throw new Error(`no intercepted item with id ${id}`);
    clearTimeout(entry.timer);
    this.intercepted.delete(id);
    try { await entry.route.abort('blockedbyclient'); } catch {}
    entry.resolve();
  }

  public async disableIntercept(): Promise<void> {
    if (!this.browser?.isConnected()) return;
    const ctx = this.browser.contexts()[0];
    if (!ctx) return;
    if (this.interceptHandler) {
      try { await ctx.unroute('**/*', this.interceptHandler); } catch {}
    }
    this.interceptHandler = null;
    this.interceptRule = null;
    // Drain any pending items by forwarding them.
    for (const id of Array.from(this.intercepted.keys())) {
      try { await this.forwardIntercepted(id); } catch {}
    }
  }

  public getInterceptRule(): InterceptRule | null {
    return this.interceptRule;
  }

  /**
   * Import storage-state-shaped cookies/origins into the attached context so the
   * opened Chrome inherits the headless session's authenticated state.
   */
  public async importStorageState(state: {
    cookies?: Array<any>;
    origins?: Array<{ origin: string; localStorage: Array<{ name: string; value: string }> }>;
  }): Promise<{ cookiesAdded: number; localStorageKeys: number }> {
    if (!this.browser?.isConnected()) {
      throw new Error('not attached — call attach() first');
    }
    const ctx = this.browser.contexts()[0];
    if (!ctx) throw new Error('no context available on attached browser');

    let cookiesAdded = 0;
    let lsKeys = 0;

    if (Array.isArray(state.cookies) && state.cookies.length) {
      await ctx.addCookies(state.cookies as any);
      cookiesAdded = state.cookies.length;
    }

    for (const origin of state.origins ?? []) {
      if (!origin?.origin || !Array.isArray(origin.localStorage)) continue;
      const page = await ctx.newPage();
      try {
        await page.goto(origin.origin, { waitUntil: 'domcontentloaded', timeout: 15_000 });
        await page.evaluate((entries: Array<{ name: string; value: string }>) => {
          for (const e of entries) {
            try { localStorage.setItem(e.name, e.value); } catch {}
          }
        }, origin.localStorage);
        lsKeys += origin.localStorage.length;
      } finally {
        await page.close();
      }
    }

    return { cookiesAdded, localStorageKeys: lsKeys };
  }

  /**
   * Export the attached Chrome's current cookies + localStorage so the caller
   * can sync them back into the headless stealth session after the human is
   * done.
   */
  public async exportStorageState(origins: string[] = []): Promise<{
    cookies: any[];
    origins: Array<{ origin: string; localStorage: Array<{ name: string; value: string }> }>;
  }> {
    if (!this.browser?.isConnected()) {
      throw new Error('not attached — call attach() first');
    }
    const ctx = this.browser.contexts()[0];
    if (!ctx) throw new Error('no context available on attached browser');

    const cookies = await ctx.cookies();
    const out: Array<{ origin: string; localStorage: Array<{ name: string; value: string }> }> = [];

    for (const origin of origins) {
      const page = await ctx.newPage();
      try {
        await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 15_000 });
        const localStorageEntries = await page.evaluate(() => {
          const arr: Array<{ name: string; value: string }> = [];
          for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k != null) arr.push({ name: k, value: localStorage.getItem(k) ?? '' });
          }
          return arr;
        });
        out.push({ origin, localStorage: localStorageEntries });
      } finally {
        await page.close();
      }
    }

    return { cookies, origins: out };
  }

  // ---------------- internals ----------------

  private spawnChrome(): ChildProcess {
    const args = [
      `--remote-debugging-port=${this.config.cdpPort}`,
      // Bind localhost only. No external CDP exposure.
      '--remote-debugging-address=127.0.0.1',
      `--user-data-dir=${this.config.userDataDir}`,
      ...this.config.extraArgs
    ];
    const env = {
      ...process.env,
      DISPLAY: this.config.display,
      // Ensure Chrome can find the user's X auth cookie for :0.
      // On typical Kali desktop this is auto-discovered via $HOME/.Xauthority.
    };
    const proc = spawn(this.config.chromeBin, args, {
      env,
      stdio: 'ignore',
      detached: false
    });
    proc.on('exit', (code, signal) => {
      Logger.info(`attached Chrome exited (code=${code} signal=${signal})`);
    });
    proc.on('error', err => {
      Logger.error('attached Chrome spawn error', err);
    });
    return proc;
  }

  private async isCdpLive(): Promise<boolean> {
    try {
      const v = await this.httpJson(`http://127.0.0.1:${this.config.cdpPort}/json/version`);
      return typeof v?.webSocketDebuggerUrl === 'string';
    } catch {
      return false;
    }
  }

  private async waitForCdp(): Promise<string> {
    const deadline = Date.now() + this.config.startupTimeoutMs;
    let lastErr = '';
    while (Date.now() < deadline) {
      try {
        const version = await this.httpJson(`http://127.0.0.1:${this.config.cdpPort}/json/version`);
        const ws = version?.webSocketDebuggerUrl;
        if (typeof ws === 'string' && ws.startsWith('ws://')) {
          return `http://127.0.0.1:${this.config.cdpPort}`;
        }
      } catch (err) {
        lastErr = (err as Error).message;
      }
      await new Promise(r => setTimeout(r, 200));
    }
    throw new Error(`Chromium CDP not reachable on :${this.config.cdpPort} within ${this.config.startupTimeoutMs}ms — last err: ${lastErr}`);
  }

  private httpJson(url: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const req = http.get(url, res => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        const chunks: Buffer[] = [];
        res.on('data', c => chunks.push(c as Buffer));
        res.on('end', () => {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
          catch (e) { reject(e as Error); }
        });
      });
      req.on('error', reject);
      req.setTimeout(1500, () => { req.destroy(new Error('timeout')); });
    });
  }

  private async cleanProfileLocks(): Promise<void> {
    // Chrome's Singleton* files in the profile dir are LEAVE-BEHINDS from unclean
    // shutdowns. They block subsequent launches with "already running" errors.
    try {
      const dir = this.config.userDataDir;
      const names = ['SingletonCookie', 'SingletonLock', 'SingletonSocket'];
      for (const name of names) {
        await fs.rm(`${dir}/${name}`, { force: true });
      }
    } catch {
      // Directory may not exist yet — fine.
    }
  }

  private isAlive(p: ChildProcess | null): boolean {
    if (!p) return false;
    if (p.exitCode != null) return false;
    if (p.killed) return false;
    return true;
  }
}

function safeQuery(url: string): Array<{ name: string; value: string }> {
  try {
    const u = new URL(url);
    const out: Array<{ name: string; value: string }> = [];
    u.searchParams.forEach((value, name) => out.push({ name, value }));
    return out;
  } catch {
    return [];
  }
}
