import { spawn, ChildProcess } from 'child_process';
import * as http from 'http';
import * as fs from 'fs/promises';
import { randomUUID } from 'crypto';
import { Browser, BrowserContext, Page, Request, Response } from 'playwright';
import { chromium as chromiumExtra } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { Logger } from '@utils/logger';

chromiumExtra.use(StealthPlugin());

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

  constructor(config: Partial<AttachConfig> = {}) {
    this.config = { ...DEFAULTS, ...config };
  }

  public getStatus(): AttachStatus {
    const alive = this.isAlive(this.proc) && !!this.browser?.isConnected();
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
    if (this.isAlive(this.proc) && this.browser?.isConnected()) {
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

    page.on('response', async (resp: Response) => {
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
        // Capture body for json/text/form under cap
        const ctl = ct.toLowerCase();
        if (ctl.includes('json') || ctl.startsWith('text/') || ctl.includes('urlencoded') || ctl.includes('javascript')) {
          try {
            const buf = await resp.body();
            entry.respBodySize = buf.length;
            if (buf.length <= RESP_BODY_MAX) {
              entry.respBody = buf.toString('utf8');
            } else {
              entry.respBody = null;
            }
          } catch {
            entry.respBody = null;
          }
        } else {
          try {
            const buf = await resp.body();
            entry.respBodySize = buf.length;
          } catch {}
          entry.respBody = null;
        }
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
  }

  private netLogPush(entry: AttachNetworkEntry): void {
    this.netLog.set(entry.id, entry);
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
