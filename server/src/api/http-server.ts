import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import { RateLimiterMemory } from 'rate-limiter-flexible';
import { Server } from 'http';
import { EventEmitter } from 'events';
import { ApiResponse, ServerConfig } from '@utils/types';
import { Logger } from '@utils/logger';
import { parseCurl, parseCookieHeader, cookieHeaderToPlaywright } from '@utils/curl-parser';
import ConfigManager from '../core/config-manager';
import SessionManager from '../core/session-manager';
import PluginManager from '../core/plugin-manager';
import { DisplayManager } from '../core/display-manager';
import { AttachManager } from '../core/attach-manager';

export class HTTPServer extends EventEmitter {
  private app: express.Application;
  private server: Server | null = null;
  private config: ServerConfig;
  private sessionManager: SessionManager;
  private pluginManager: PluginManager;
  private displayManager: DisplayManager;
  private attachManager: AttachManager;
  private rateLimiter: RateLimiterMemory;
  private isInitialized = false;

  constructor(
    sessionManager: SessionManager,
    pluginManager: PluginManager,
    displayManager: DisplayManager,
    attachManager: AttachManager
  ) {
    super();
    this.config = ConfigManager.getInstance().get<ServerConfig>('server');
    this.sessionManager = sessionManager;
    this.pluginManager = pluginManager;
    this.displayManager = displayManager;
    this.attachManager = attachManager;
    this.app = express();

    // Initialize rate limiter
    this.rateLimiter = new RateLimiterMemory({
      points: this.config.rateLimit.max,
      duration: this.config.rateLimit.windowMs / 1000,
    });
  }

  public async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    Logger.info('Initializing HTTP Server');

    // Setup middleware
    this.setupMiddleware();

    // Setup routes
    this.setupRoutes();

    // Setup error handling
    this.setupErrorHandling();

    this.isInitialized = true;
    Logger.info('HTTP Server initialized');
  }

  public async start(): Promise<void> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    return new Promise((resolve, reject) => {
      this.server = this.app.listen(this.config.http.port, this.config.http.host, () => {
        this.emit('started');
        Logger.info(`HTTP Server started on ${this.config.http.host}:${this.config.http.port}`);
        resolve();
      });

      this.server.on('error', (error) => {
        Logger.error('HTTP Server error', error);
        reject(error);
      });
    });
  }

  public async shutdown(): Promise<void> {
    if (!this.server) {
      return;
    }

    Logger.info('Shutting down HTTP Server');

    return new Promise((resolve) => {
      this.server!.close(() => {
        this.emit('shutdown');
        Logger.info('HTTP Server shutdown complete');
        resolve();
      });
    });
  }

  public getHealth(): any {
    return {
      status: this.server ? 'running' : 'stopped',
      port: this.config.http.port,
      uptime: this.server ? Date.now() - (this.server as any).startTime : 0,
      connections: this.server ? (this.server as any).connections || 0 : 0
    };
  }

  private setupMiddleware(): void {
    // Security middleware
    this.app.use(helmet(this.config.security?.helmet || {}));

    // Compression
    if (this.config.security?.compression) {
      this.app.use(compression());
    }

    // CORS
    if (this.config.http.cors.enabled) {
      this.app.use(cors({
        origin: this.config.http.cors.origins,
        credentials: true
      }));
    }

    // Body parsing
    this.app.use(express.json({ limit: '10mb' }));
    this.app.use(express.urlencoded({ extended: true, limit: '10mb' }));

    // Request logging
    this.app.use((req, res, next) => {
      const start = Date.now();
      res.on('finish', () => {
        const duration = Date.now() - start;
        Logger.api(req.method, req.path, res.statusCode, duration, {
          userAgent: req.get('User-Agent'),
          ip: req.ip
        });
      });
      next();
    });

    // Rate limiting
    this.app.use(async (req, res, next) => {
      try {
        await this.rateLimiter.consume(req.ip || req.connection.remoteAddress || 'unknown');
        next();
      } catch (rateLimiterRes) {
        res.status(429).json(this.createErrorResponse('RATE_LIMIT_EXCEEDED', this.config.rateLimit.message));
      }
    });
  }

  private setupRoutes(): void {
    // Health check
    this.app.get('/v2/health', (req, res) => {
      const health = {
        status: 'healthy',
        timestamp: new Date().toISOString(),
        version: '2.0.0',
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        sessions: this.sessionManager.getSessionsHealth(),
        browser: this.sessionManager ? {
          instances: (this.sessionManager as any).browserManager.health()
        } : null
      };

      res.json(this.createSuccessResponse(health));
    });

    // Create session
    this.app.post('/v2/sessions', async (req, res) => {
      try {
        const options = req.body || {};
        const session = await this.sessionManager.createSession(options);

        res.json(this.createSuccessResponse({
          sessionId: session.id,
          metadata: session.metadata,
          created: true
        }));
      } catch (error) {
        res.status(400).json(this.createErrorResponse('SESSION_CREATE_FAILED', (error as Error).message));
      }
    });

    // Get session info
    this.app.get('/v2/sessions/:sessionId', (req, res) => {
      const session = this.sessionManager.getSession(req.params.sessionId);
      if (!session) {
        return res.status(404).json(this.createErrorResponse('SESSION_NOT_FOUND', 'Session not found'));
      }

      return res.json(this.createSuccessResponse({
        sessionId: session.id,
        metadata: session.metadata,
        metrics: session.metrics,
        isActive: session.isActive
      }));
    });

    // List sessions
    this.app.get('/v2/sessions', (req, res) => {
      const sessions = this.sessionManager.getAllSessions();
      const sessionList = sessions.map(session => ({
        sessionId: session.id,
        metadata: session.metadata,
        isActive: session.isActive,
        createdAt: session.createdAt,
        lastActivity: session.lastActivity
      }));

      return res.json(this.createSuccessResponse({
        sessions: sessionList,
        total: sessionList.length,
        active: sessionList.filter(s => s.isActive).length
      }));
    });

    // Navigate
    this.app.post('/v2/sessions/:sessionId/navigate', async (req, res) => {
      try {
        const { url, waitUntil = 'networkidle', timeout = 30000 } = req.body;
        const session = this.sessionManager.getSession(req.params.sessionId);

        if (!session) {
          return res.status(404).json(this.createErrorResponse('SESSION_NOT_FOUND', 'Session not found'));
        }

        // Execute plugin hooks before navigation
        await this.pluginManager.executeHook('beforeNavigation', session, url, session.page);

        await session.page.goto(url, { waitUntil, timeout });
        this.sessionManager.updateSessionActivity(session.id);

        // Execute plugin hooks after navigation
        await this.pluginManager.executeHook('afterNavigation', session, url, session.page);

        return res.json(this.createSuccessResponse({
          url: session.page.url(),
          title: await session.page.title(),
          navigated: true
        }));
      } catch (error) {
        return res.status(400).json(this.createErrorResponse('NAVIGATION_FAILED', (error as Error).message));
      }
    });

    // Take screenshot
    this.app.post('/v2/sessions/:sessionId/screenshot', async (req, res) => {
      try {
        const session = this.sessionManager.getSession(req.params.sessionId);
        if (!session) {
          return res.status(404).json(this.createErrorResponse('SESSION_NOT_FOUND', 'Session not found'));
        }

        const options = req.body || {};
        const screenshot = await session.page.screenshot({
          type: 'png',
          fullPage: options.fullPage || false,
          ...options
        });

        this.sessionManager.updateSessionActivity(session.id);

        return res.json(this.createSuccessResponse({
          screenshot: screenshot.toString('base64'),
          contentType: 'image/png',
          timestamp: new Date().toISOString()
        }));
      } catch (error) {
        return res.status(400).json(this.createErrorResponse('SCREENSHOT_FAILED', (error as Error).message));
      }
    });

    // Click element
    this.app.post('/v2/sessions/:sessionId/click', async (req, res) => {
      try {
        const session = this.sessionManager.getSession(req.params.sessionId);
        if (!session) {
          return res.status(404).json(this.createErrorResponse('SESSION_NOT_FOUND', 'Session not found'));
        }

        const { selector } = req.body;
        await session.page.click(selector);
        this.sessionManager.updateSessionActivity(session.id);

        return res.json(this.createSuccessResponse({ clicked: true }));
      } catch (error) {
        return res.status(400).json(this.createErrorResponse('CLICK_FAILED', (error as Error).message));
      }
    });

    // Type text
    this.app.post('/v2/sessions/:sessionId/type', async (req, res) => {
      try {
        const session = this.sessionManager.getSession(req.params.sessionId);
        if (!session) {
          return res.status(404).json(this.createErrorResponse('SESSION_NOT_FOUND', 'Session not found'));
        }

        const { selector, text } = req.body;
        await session.page.fill(selector, text);
        this.sessionManager.updateSessionActivity(session.id);

        return res.json(this.createSuccessResponse({ typed: true }));
      } catch (error) {
        return res.status(400).json(this.createErrorResponse('TYPE_FAILED', (error as Error).message));
      }
    });

    // Execute JavaScript
    this.app.post('/v2/sessions/:sessionId/execute', async (req, res) => {
      try {
        const session = this.sessionManager.getSession(req.params.sessionId);
        if (!session) {
          return res.status(404).json(this.createErrorResponse('SESSION_NOT_FOUND', 'Session not found'));
        }

        const { script } = req.body;
        const result = await session.page.evaluate(script);
        this.sessionManager.updateSessionActivity(session.id);

        return res.json(this.createSuccessResponse({ result }));
      } catch (error) {
        return res.status(400).json(this.createErrorResponse('EXECUTE_FAILED', (error as Error).message));
      }
    });

    // Get cookies
    this.app.get('/v2/sessions/:sessionId/cookies', async (req, res) => {
      try {
        const session = this.sessionManager.getSession(req.params.sessionId);
        if (!session) {
          return res.status(404).json(this.createErrorResponse('SESSION_NOT_FOUND', 'Session not found'));
        }

        const cookies = await session.context.cookies();
        this.sessionManager.updateSessionActivity(session.id);

        return res.json(this.createSuccessResponse({
          cookies,
          count: cookies.length
        }));
      } catch (error) {
        return res.status(400).json(this.createErrorResponse('COOKIES_FAILED', (error as Error).message));
      }
    });

    // Import cookies into a session.
    // Body shape 1: { cookies: Playwright.Cookie[] }
    // Body shape 2: { cookieHeader: "k1=v1; k2=v2", domain: "example.com" }
    this.app.post('/v2/sessions/:sessionId/cookies/import', async (req, res) => {
      try {
        const { sessionId } = req.params;
        const body = req.body || {};

        let cookies: Array<any> = [];
        if (Array.isArray(body.cookies)) {
          cookies = body.cookies;
        } else if (typeof body.cookieHeader === 'string') {
          if (!body.domain) {
            return res.status(400).json(this.createErrorResponse(
              'DOMAIN_REQUIRED',
              'When supplying cookieHeader, `domain` (e.g. "rapyd.net") is required'
            ));
          }
          cookies = cookieHeaderToPlaywright(body.cookieHeader, body.domain, body.options || {});
        } else {
          return res.status(400).json(this.createErrorResponse(
            'INVALID_BODY',
            'Provide either `cookies: []` or `cookieHeader: "..."` with `domain`'
          ));
        }

        const count = await this.sessionManager.importCookies(sessionId, cookies);
        return res.json(this.createSuccessResponse({ imported: count }));
      } catch (error) {
        return res.status(400).json(this.createErrorResponse(
          'COOKIE_IMPORT_FAILED',
          (error as Error).message
        ));
      }
    });

    // Parse a DevTools "Copy as cURL (bash)" string and import the cookies +
    // custom headers. Returns what got extracted so the caller can sanity-check.
    this.app.post('/v2/sessions/:sessionId/cookies/import-curl', async (req, res) => {
      try {
        const { sessionId } = req.params;
        const { curl } = req.body || {};
        if (typeof curl !== 'string' || curl.length === 0) {
          return res.status(400).json(this.createErrorResponse(
            'INVALID_BODY',
            'Provide `curl: "<full curl command string>"`'
          ));
        }

        const parsed = parseCurl(curl);
        if (!parsed.url) {
          return res.status(400).json(this.createErrorResponse(
            'CURL_NO_URL',
            'Could not extract a URL from the curl command'
          ));
        }

        let host = '';
        try {
          host = new URL(parsed.url).hostname;
        } catch {
          return res.status(400).json(this.createErrorResponse(
            'CURL_BAD_URL',
            `Extracted URL is not valid: ${parsed.url}`
          ));
        }

        const domain = '.' + host.replace(/^www\./, '');
        const cookieEntries = Object.entries(parsed.cookies).map(([name, value]) => ({
          name,
          value,
          domain,
          path: '/',
          httpOnly: true,
          secure: true,
          sameSite: 'Lax' as const
        }));

        let imported = 0;
        if (cookieEntries.length > 0) {
          imported = await this.sessionManager.importCookies(sessionId, cookieEntries);
        }

        // Strip the Cookie header from the returned headers — it's already in cookieEntries.
        const extraHeaders = { ...parsed.headers };
        delete extraHeaders['Cookie'];
        delete extraHeaders['cookie'];

        return res.json(this.createSuccessResponse({
          url: parsed.url,
          method: parsed.method,
          host,
          cookiesImported: imported,
          extraHeaders,
          bodyBytes: parsed.body ? parsed.body.length : 0
        }));
      } catch (error) {
        return res.status(400).json(this.createErrorResponse(
          'CURL_IMPORT_FAILED',
          (error as Error).message
        ));
      }
    });

    // Get auth-like request headers captured by the sniffer.
    // Optional query: ?host=<hostname> to scope.
    this.app.get('/v2/sessions/:sessionId/auth-headers', (req, res) => {
      const { sessionId } = req.params;
      const hostFilter = typeof req.query.host === 'string' ? req.query.host : undefined;
      if (!this.sessionManager.getSession(sessionId)) {
        return res.status(404).json(this.createErrorResponse('SESSION_NOT_FOUND', 'Session not found'));
      }
      const headers = this.sessionManager.getCapturedHeaders(sessionId, hostFilter);
      return res.json(this.createSuccessResponse({ headers, count: headers.length }));
    });

    // Query in-memory network log (metadata only — bodies are fetched per-id).
    // Query params: filter (URL substring), method, status, failed, since (ISO), limit (<=1000)
    this.app.get('/v2/sessions/:sessionId/network', (req, res) => {
      const { sessionId } = req.params;
      const netLogger = this.sessionManager.getNetworkLogger(sessionId);
      if (!netLogger) {
        return res.status(404).json(this.createErrorResponse('SESSION_NOT_FOUND', 'Session or network logger not found'));
      }
      const entries = netLogger.query({
        ...(typeof req.query.filter === 'string' ? { filter: req.query.filter } : {}),
        ...(typeof req.query.method === 'string' ? { method: req.query.method } : {}),
        ...(typeof req.query.since === 'string' ? { since: req.query.since } : {}),
        ...(typeof req.query.status === 'string' ? { status: parseInt(req.query.status, 10) } : {}),
        ...(typeof req.query.failed === 'string' ? { failed: req.query.failed === 'true' } : {}),
        ...(typeof req.query.limit === 'string' ? { limit: parseInt(req.query.limit, 10) } : {})
      });
      return res.json(this.createSuccessResponse({
        entries,
        count: entries.length,
        note: 'Use GET /v2/sessions/:id/network/:reqId for full request+response bodies'
      }));
    });

    // Get a single network log entry with full request + response bodies.
    this.app.get('/v2/sessions/:sessionId/network/:reqId', (req, res) => {
      const { sessionId, reqId } = req.params;
      const netLogger = this.sessionManager.getNetworkLogger(sessionId);
      if (!netLogger) {
        return res.status(404).json(this.createErrorResponse('SESSION_NOT_FOUND', 'Session or network logger not found'));
      }
      const entry = netLogger.getById(reqId);
      if (!entry) {
        return res.status(404).json(this.createErrorResponse('REQUEST_NOT_FOUND', 'Request id not found in buffer (may have been rotated out — check JSONL file on disk)'));
      }
      return res.json(this.createSuccessResponse(entry));
    });

    // Emit a HAR 1.2 document reconstructed from the in-memory buffer.
    // Good enough to import into Burp / HTTP Toolkit / Chrome DevTools.
    this.app.get('/v2/sessions/:sessionId/har', (req, res) => {
      const { sessionId } = req.params;
      const netLogger = this.sessionManager.getNetworkLogger(sessionId);
      if (!netLogger) {
        return res.status(404).json(this.createErrorResponse('SESSION_NOT_FOUND', 'Session or network logger not found'));
      }
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="sess-${sessionId}.har"`);
      return res.send(JSON.stringify(netLogger.toHAR(), null, 2));
    });

    // Start x11vnc + websockify so the user can see + interact with Chromium.
    // Returns a URL the user opens in their own browser. Use when a captcha /
    // MFA / KYB form needs human input.
    this.app.post('/v2/display/show', async (_req, res) => {
      try {
        const status = await this.displayManager.show();
        return res.json(this.createSuccessResponse(status));
      } catch (error) {
        return res.status(500).json(this.createErrorResponse('DISPLAY_SHOW_FAILED', (error as Error).message));
      }
    });

    // Stop the VNC/websockify bridges. Chromium stays alive under Xvfb.
    this.app.post('/v2/display/hide', async (_req, res) => {
      try {
        const status = await this.displayManager.hide();
        return res.json(this.createSuccessResponse(status));
      } catch (error) {
        return res.status(500).json(this.createErrorResponse('DISPLAY_HIDE_FAILED', (error as Error).message));
      }
    });

    this.app.get('/v2/display/status', (_req, res) => {
      return res.json(this.createSuccessResponse(this.displayManager.getStatus()));
    });

    // ==================== Attach mode (headed Chrome on user's display) ===
    // Preferred over /v2/display/* (noVNC). Spawns a real Chromium window on
    // the user's live X display so they can see/interact with it directly;
    // Playwright drives the same browser via CDP for automation + network
    // capture. Use when Claude hits a human-only gate (captcha / MFA / KYB).

    this.app.post('/v2/attach', async (req, res) => {
      try {
        const { url, sourceSessionId, syncOrigins } = req.body || {};
        const attach = await this.attachManager.attach();

        // Optionally pre-populate the attached Chrome with cookies / storage
        // from an existing headless session so the user doesn't have to redo
        // any auth they already cleared there.
        let imported: { cookiesAdded: number; localStorageKeys: number } | null = null;
        if (typeof sourceSessionId === 'string') {
          const src = this.sessionManager.getSession(sourceSessionId);
          if (!src) {
            return res.status(404).json(this.createErrorResponse(
              'SOURCE_SESSION_NOT_FOUND',
              `sourceSessionId ${sourceSessionId} not found`
            ));
          }
          const state = await src.context.storageState();
          imported = await this.attachManager.importStorageState(state as any);
        }

        // Optional: navigate the attached tab straight to a target URL so the
        // user sees the page they need to interact with immediately.
        if (typeof url === 'string' && url.length > 0) {
          try {
            await attach.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
          } catch (err) {
            Logger.error('attach.goto failed', err);
          }
        }

        return res.json(this.createSuccessResponse({
          ...this.attachManager.getStatus(),
          imported,
          currentUrl: attach.page.url(),
          note: 'Chrome is open on the user\'s display. When the human step is done, POST /v2/detach (and optionally /v2/attach/sync-to-session first to copy cookies back).'
        }));
      } catch (error) {
        return res.status(500).json(this.createErrorResponse('ATTACH_FAILED', (error as Error).message));
      }
    });

    this.app.post('/v2/detach', async (_req, res) => {
      try {
        await this.attachManager.detach();
        return res.json(this.createSuccessResponse(this.attachManager.getStatus()));
      } catch (error) {
        return res.status(500).json(this.createErrorResponse('DETACH_FAILED', (error as Error).message));
      }
    });

    this.app.get('/v2/attach/status', (_req, res) => {
      return res.json(this.createSuccessResponse(this.attachManager.getStatus()));
    });

    // Wipe the profile directory — use between programs or if the attached
    // Chrome's state is polluted.
    this.app.post('/v2/attach/reset', async (_req, res) => {
      try {
        await this.attachManager.reset();
        return res.json(this.createSuccessResponse({ reset: true }));
      } catch (error) {
        return res.status(500).json(this.createErrorResponse('RESET_FAILED', (error as Error).message));
      }
    });

    // Point the already-attached tab at a new URL (e.g. after the user
    // finished a sub-step and Claude wants to navigate elsewhere).
    this.app.post('/v2/attach/navigate', async (req, res) => {
      try {
        const { url, waitUntil = 'domcontentloaded', timeout = 30_000 } = req.body || {};
        if (typeof url !== 'string' || !url) {
          return res.status(400).json(this.createErrorResponse('URL_REQUIRED', 'Provide `url`'));
        }
        const status = this.attachManager.getStatus();
        if (!status.running) {
          return res.status(400).json(this.createErrorResponse('NOT_ATTACHED', 'Call /v2/attach first'));
        }
        const attach = await this.attachManager.attach();
        await attach.page.goto(url, { waitUntil, timeout });
        return res.json(this.createSuccessResponse({
          currentUrl: attach.page.url(),
          title: await attach.page.title()
        }));
      } catch (error) {
        return res.status(400).json(this.createErrorResponse('ATTACH_NAV_FAILED', (error as Error).message));
      }
    });

    // Body: { sessionId, origins?: string[] }
    // Pull storage state out of the attached Chrome (cookies + localStorage for
    // the listed origins) and import into the named headless session so post-
    // interaction state (e.g. fresh auth cookies) is reflected there.
    this.app.post('/v2/attach/sync-to-session', async (req, res) => {
      try {
        const { sessionId, origins = [] } = req.body || {};
        if (typeof sessionId !== 'string' || !sessionId) {
          return res.status(400).json(this.createErrorResponse('SESSION_REQUIRED', 'Provide `sessionId` of the headless target session'));
        }
        const target = this.sessionManager.getSession(sessionId);
        if (!target) {
          return res.status(404).json(this.createErrorResponse('SESSION_NOT_FOUND', `target session ${sessionId} not found`));
        }
        const exported = await this.attachManager.exportStorageState(origins);
        if (exported.cookies.length) {
          await target.context.addCookies(exported.cookies as any);
        }
        // localStorage per-origin sync requires navigating that origin in the
        // headless context first; we do best-effort and swallow navigation errors
        // (the target may not have a page pointed at the origin).
        let lsTouched = 0;
        for (const o of exported.origins) {
          try {
            await target.page.goto(o.origin, { waitUntil: 'domcontentloaded', timeout: 15_000 });
            await target.page.evaluate((entries: Array<{ name: string; value: string }>) => {
              for (const e of entries) { try { localStorage.setItem(e.name, e.value); } catch {} }
            }, o.localStorage);
            lsTouched += o.localStorage.length;
          } catch (err) {
            Logger.error(`sync-to-session: could not restore localStorage for ${o.origin}`, err);
          }
        }
        this.sessionManager.updateSessionActivity(sessionId);
        return res.json(this.createSuccessResponse({
          cookiesSynced: exported.cookies.length,
          localStorageKeysSynced: lsTouched
        }));
      } catch (error) {
        return res.status(500).json(this.createErrorResponse('ATTACH_SYNC_FAILED', (error as Error).message));
      }
    });

    // ---------------- Drive-mode endpoints ----------------
    // Evaluate arbitrary JS in the attached primary tab.
    // Body: { script: string, arg?: any }  — script may be an expression or a
    // block (with a `return`). If block, receives `__arg` as the arg param.
    this.app.post('/v2/attach/eval', async (req, res) => {
      try {
        const { script, arg } = req.body || {};
        if (typeof script !== 'string' || !script) {
          return res.status(400).json(this.createErrorResponse('SCRIPT_REQUIRED', 'Provide a JS string in `script`'));
        }
        const result = await this.attachManager.eval(script, arg);
        return res.json(this.createSuccessResponse({ result }));
      } catch (error) {
        return res.status(500).json(this.createErrorResponse('ATTACH_EVAL_FAILED', (error as Error).message));
      }
    });

    // Body: { selector: string, text: string, delay?: number, clear?: boolean }
    this.app.post('/v2/attach/type', async (req, res) => {
      try {
        const { selector, text, delay, clear } = req.body || {};
        if (typeof selector !== 'string' || typeof text !== 'string') {
          return res.status(400).json(this.createErrorResponse('BAD_INPUT', 'Provide `selector` and `text` strings'));
        }
        await this.attachManager.type(selector, text, { delay, clear });
        return res.json(this.createSuccessResponse({ typed: true, selector, len: text.length }));
      } catch (error) {
        return res.status(500).json(this.createErrorResponse('ATTACH_TYPE_FAILED', (error as Error).message));
      }
    });

    // Body: { selector?: string, text: string, delay?: number }
    // Focus selector (if given) then send real keystrokes via CDP Input domain.
    // Use this for React-controlled inputs where setter+input events don't fire
    // the framework's internal state update.
    this.app.post('/v2/attach/keyboard-type', async (req, res) => {
      try {
        const { selector, text, delay } = req.body || {};
        if (typeof text !== 'string') {
          return res.status(400).json(this.createErrorResponse('BAD_INPUT', 'Provide `text` string'));
        }
        await this.attachManager.keyboardType(selector ?? null, text, delay);
        return res.json(this.createSuccessResponse({ typed: true, len: text.length }));
      } catch (error) {
        return res.status(500).json(this.createErrorResponse('ATTACH_KEYBOARD_FAILED', (error as Error).message));
      }
    });

    // Body: { text: string, human?: boolean }  — click first element containing this text.
    this.app.post('/v2/attach/click-text', async (req, res) => {
      try {
        const { text, human } = req.body || {};
        if (typeof text !== 'string' || !text) {
          return res.status(400).json(this.createErrorResponse('BAD_INPUT', 'Provide `text`'));
        }
        await this.attachManager.clickText(text, { human: !!human });
        return res.json(this.createSuccessResponse({ clicked: text, human: !!human }));
      } catch (error) {
        return res.status(500).json(this.createErrorResponse('ATTACH_CLICKTEXT_FAILED', (error as Error).message));
      }
    });

    // Body: { selector: string, human?: boolean }
    this.app.post('/v2/attach/click', async (req, res) => {
      try {
        const { selector, human } = req.body || {};
        if (typeof selector !== 'string' || !selector) {
          return res.status(400).json(this.createErrorResponse('BAD_INPUT', 'Provide `selector` string'));
        }
        await this.attachManager.click(selector, { human: !!human });
        return res.json(this.createSuccessResponse({ clicked: true, selector, human: !!human }));
      } catch (error) {
        return res.status(500).json(this.createErrorResponse('ATTACH_CLICK_FAILED', (error as Error).message));
      }
    });

    // Body: { x: number, y: number }  — move cursor along a human-ish curved path.
    this.app.post('/v2/attach/mouse-move', async (req, res) => {
      try {
        const { x, y } = req.body || {};
        if (typeof x !== 'number' || typeof y !== 'number') {
          return res.status(400).json(this.createErrorResponse('BAD_INPUT', 'Provide numeric `x` and `y`'));
        }
        return res.json(this.createSuccessResponse(await this.attachManager.mouseMove(x, y)));
      } catch (error) {
        return res.status(500).json(this.createErrorResponse('ATTACH_MOUSEMOVE_FAILED', (error as Error).message));
      }
    });

    // Returns a trimmed innerText of the body + title + url.
    this.app.get('/v2/attach/page-text', async (req, res) => {
      try {
        const limit = Math.min(Number(req.query.limit) || 8000, 30_000);
        const data = await this.attachManager.pageText(limit);
        return res.json(this.createSuccessResponse(data));
      } catch (error) {
        return res.status(500).json(this.createErrorResponse('ATTACH_PAGETEXT_FAILED', (error as Error).message));
      }
    });

    // Returns all form fields + buttons on the primary tab.
    this.app.get('/v2/attach/form', async (_req, res) => {
      try {
        const data = await this.attachManager.snapshotForm();
        return res.json(this.createSuccessResponse(data));
      } catch (error) {
        return res.status(500).json(this.createErrorResponse('ATTACH_FORM_FAILED', (error as Error).message));
      }
    });

    // List / switch tabs.
    this.app.get('/v2/attach/tabs', async (_req, res) => {
      try {
        const tabs = await this.attachManager.listTabs();
        return res.json(this.createSuccessResponse({ tabs }));
      } catch (error) {
        return res.status(500).json(this.createErrorResponse('ATTACH_TABS_FAILED', (error as Error).message));
      }
    });

    // Body: { urlSubstring: string }
    this.app.post('/v2/attach/select-tab', async (req, res) => {
      try {
        const { urlSubstring } = req.body || {};
        if (typeof urlSubstring !== 'string' || !urlSubstring) {
          return res.status(400).json(this.createErrorResponse('BAD_INPUT', 'Provide `urlSubstring`'));
        }
        const result = await this.attachManager.selectTab(urlSubstring);
        return res.json(this.createSuccessResponse(result));
      } catch (error) {
        return res.status(500).json(this.createErrorResponse('ATTACH_SELECT_TAB_FAILED', (error as Error).message));
      }
    });

    // Network query (meta only). Query params: filter, method, status, since, limit
    this.app.get('/v2/attach/network', (req, res) => {
      try {
        const { filter, method, status, since, limit } = req.query as Record<string, string | undefined>;
        const entries = this.attachManager.queryNetwork({
          ...(filter ? { filter } : {}),
          ...(method ? { method } : {}),
          ...(status ? { status: Number(status) } : {}),
          ...(since ? { since } : {}),
          ...(limit ? { limit: Math.min(Number(limit), 1000) } : {})
        });
        return res.json(this.createSuccessResponse({ count: entries.length, entries }));
      } catch (error) {
        return res.status(500).json(this.createErrorResponse('ATTACH_NETWORK_QUERY_FAILED', (error as Error).message));
      }
    });

    // Single network entry detail (with bodies).
    this.app.get('/v2/attach/network/:id', (req, res) => {
      const entry = this.attachManager.getNetworkEntry(req.params.id);
      if (!entry) {
        return res.status(404).json(this.createErrorResponse('NOT_FOUND', 'No network entry with that id'));
      }
      return res.json(this.createSuccessResponse(entry));
    });

    this.app.post('/v2/attach/network/clear', (_req, res) => {
      const cleared = this.attachManager.clearNetwork();
      return res.json(this.createSuccessResponse({ cleared }));
    });

    // ---------------- Cookies (#16, #17, #18) ----------------

    // GET /v2/attach/cookies?domain=&name=
    this.app.get('/v2/attach/cookies', async (req, res) => {
      try {
        const domain = typeof req.query.domain === 'string' ? req.query.domain : undefined;
        const name = typeof req.query.name === 'string' ? req.query.name : undefined;
        const filters: { domain?: string; name?: string } = {};
        if (domain) filters.domain = domain;
        if (name) filters.name = name;
        const cookies = await this.attachManager.getCookies(filters);
        return res.json(this.createSuccessResponse({ cookies, count: cookies.length }));
      } catch (error) {
        return res.status(400).json(this.createErrorResponse('ATTACH_COOKIES_GET_FAILED', (error as Error).message));
      }
    });

    // POST /v2/attach/cookies/delete { domain?, name?, path? }
    this.app.post('/v2/attach/cookies/delete', async (req, res) => {
      try {
        const { domain, name, path } = req.body || {};
        const filters: { domain?: string; name?: string; path?: string } = {};
        if (typeof domain === 'string' && domain) filters.domain = domain;
        if (typeof name === 'string' && name) filters.name = name;
        if (typeof path === 'string' && path) filters.path = path;
        const result = await this.attachManager.deleteCookies(filters);
        return res.json(this.createSuccessResponse(result));
      } catch (error) {
        return res.status(400).json(this.createErrorResponse('ATTACH_COOKIES_DELETE_FAILED', (error as Error).message));
      }
    });

    // POST /v2/attach/cookies/snapshot { name }
    this.app.post('/v2/attach/cookies/snapshot', async (req, res) => {
      try {
        const { name } = req.body || {};
        if (typeof name !== 'string' || !name) {
          return res.status(400).json(this.createErrorResponse('BAD_INPUT', 'Provide `name`'));
        }
        const out = await this.attachManager.snapshotCookies(name);
        return res.json(this.createSuccessResponse(out));
      } catch (error) {
        return res.status(400).json(this.createErrorResponse('ATTACH_COOKIES_SNAPSHOT_FAILED', (error as Error).message));
      }
    });

    // GET /v2/attach/cookies/snapshots — list saved snapshots
    this.app.get('/v2/attach/cookies/snapshots', (_req, res) => {
      const list = this.attachManager.listCookieSnapshots();
      return res.json(this.createSuccessResponse({ snapshots: list, count: list.length }));
    });

    // GET /v2/attach/cookies/diff?before=X&after=Y (after optional, defaults to 'current')
    this.app.get('/v2/attach/cookies/diff', async (req, res) => {
      try {
        const before = typeof req.query.before === 'string' ? req.query.before : '';
        const after = typeof req.query.after === 'string' && req.query.after ? req.query.after : 'current';
        if (!before) {
          return res.status(400).json(this.createErrorResponse('BAD_INPUT', 'Provide `before` snapshot name'));
        }
        const diff = await this.attachManager.diffCookieSnapshots(before, after);
        return res.json(this.createSuccessResponse({
          before,
          after,
          addedCount: diff.added.length,
          removedCount: diff.removed.length,
          changedCount: diff.changed.length,
          ...diff
        }));
      } catch (error) {
        const msg = (error as Error).message;
        const code = msg.includes('not found') ? 'SNAPSHOT_NOT_FOUND' : 'ATTACH_COOKIES_DIFF_FAILED';
        const status = code === 'SNAPSHOT_NOT_FOUND' ? 404 : 400;
        return res.status(status).json(this.createErrorResponse(code, msg));
      }
    });

    // ---------------- Waits (#21) ----------------

    // POST /v2/attach/wait-for { text?, selector?, timeout? }
    this.app.post('/v2/attach/wait-for', async (req, res) => {
      try {
        const { text, selector, timeout } = req.body || {};
        const target: { text?: string; selector?: string } = {};
        if (typeof text === 'string' && text) target.text = text;
        if (typeof selector === 'string' && selector) target.selector = selector;
        if (!target.text && !target.selector) {
          return res.status(400).json(this.createErrorResponse('BAD_INPUT', 'Provide `text` or `selector`'));
        }
        const to = typeof timeout === 'number' ? timeout : 10_000;
        const out = await this.attachManager.waitFor(target, to);
        return res.json(this.createSuccessResponse(out));
      } catch (error) {
        return res.status(400).json(this.createErrorResponse('ATTACH_WAIT_FAILED', (error as Error).message));
      }
    });

    // ---------------- Visual capture (#24, #7) ----------------

    // POST /v2/attach/screenshot { fullPage?, path?, selector?, returnBase64? }
    this.app.post('/v2/attach/screenshot', async (req, res) => {
      try {
        const { fullPage, path, selector, returnBase64 } = req.body || {};
        const opts: { fullPage?: boolean; path?: string; selector?: string; returnBase64?: boolean } = {};
        if (typeof fullPage === 'boolean') opts.fullPage = fullPage;
        if (typeof path === 'string' && path) opts.path = path;
        if (typeof selector === 'string' && selector) opts.selector = selector;
        if (typeof returnBase64 === 'boolean') opts.returnBase64 = returnBase64;
        const out = await this.attachManager.screenshot(opts);
        return res.json(this.createSuccessResponse(out));
      } catch (error) {
        return res.status(400).json(this.createErrorResponse('ATTACH_SCREENSHOT_FAILED', (error as Error).message));
      }
    });

    // POST /v2/attach/dom-snapshot { path? }
    this.app.post('/v2/attach/dom-snapshot', async (req, res) => {
      try {
        const { path } = req.body || {};
        const out = await this.attachManager.domSnapshot(typeof path === 'string' && path ? path : undefined);
        return res.json(this.createSuccessResponse(out));
      } catch (error) {
        return res.status(400).json(this.createErrorResponse('ATTACH_DOM_SNAPSHOT_FAILED', (error as Error).message));
      }
    });

    // ---------------- Token extraction (#5) ----------------

    // GET /v2/attach/tokens
    this.app.get('/v2/attach/tokens', async (_req, res) => {
      try {
        const out = await this.attachManager.extractTokens();
        return res.json(this.createSuccessResponse(out));
      } catch (error) {
        return res.status(400).json(this.createErrorResponse('ATTACH_TOKENS_FAILED', (error as Error).message));
      }
    });

    // ---------------- Captcha solver (2captcha) ----------------

    // GET /v2/attach/captcha/detect — auto-detect captcha type+sitekey on current tab.
    this.app.get('/v2/attach/captcha/detect', async (_req, res) => {
      try {
        const out = await this.attachManager.detectCaptcha();
        return res.json(this.createSuccessResponse(out));
      } catch (error) {
        return res.status(400).json(this.createErrorResponse('CAPTCHA_DETECT_FAILED', (error as Error).message));
      }
    });

    // POST /v2/attach/captcha/solve — solve via 2captcha. Body forwards SolveOpts.
    this.app.post('/v2/attach/captcha/solve', async (req, res) => {
      try {
        const opts = req.body || {};
        const out = await this.attachManager.solveCaptcha(opts);
        return res.json(this.createSuccessResponse(out));
      } catch (error) {
        return res.status(400).json(this.createErrorResponse('CAPTCHA_SOLVE_FAILED', (error as Error).message));
      }
    });

    // GET /v2/attach/captcha/balance — current 2captcha account balance ($).
    this.app.get('/v2/attach/captcha/balance', async (req, res) => {
      try {
        const apiKey = (req.query.apiKey as string) || undefined;
        const out = await this.attachManager.getCaptchaBalance(apiKey);
        return res.json(this.createSuccessResponse(out));
      } catch (error) {
        return res.status(400).json(this.createErrorResponse('CAPTCHA_BALANCE_FAILED', (error as Error).message));
      }
    });

    // ---------------- Cloudflare interstitial ----------------

    // GET /v2/attach/cloudflare/detect — classify any Cloudflare challenge on the current tab.
    this.app.get('/v2/attach/cloudflare/detect', async (_req, res) => {
      try {
        return res.json(this.createSuccessResponse(await this.attachManager.detectCloudflare()));
      } catch (error) {
        return res.status(400).json(this.createErrorResponse('CF_DETECT_FAILED', (error as Error).message));
      }
    });

    // POST /v2/attach/cloudflare/solve — clear the interstitial (free; coordinate-click). Body: {maxRecursion?, pollMs?}
    this.app.post('/v2/attach/cloudflare/solve', async (req, res) => {
      try {
        return res.json(this.createSuccessResponse(await this.attachManager.solveCloudflare(req.body || {})));
      } catch (error) {
        return res.status(400).json(this.createErrorResponse('CF_SOLVE_FAILED', (error as Error).message));
      }
    });

    // ---------------- Chain runner ----------------

    // POST /v2/attach/chain — run a sequence of browser ops server-side, return final state.
    // Body: { steps: ChainStep[], continueOnError?: boolean }
    this.app.post('/v2/attach/chain', async (req, res) => {
      try {
        const { steps, continueOnError } = req.body || {};
        if (!Array.isArray(steps) || steps.length === 0) {
          return res.status(400).json(this.createErrorResponse('BAD_INPUT', 'Provide non-empty `steps` array'));
        }
        return res.json(this.createSuccessResponse(await this.attachManager.runChain(steps, { continueOnError })));
      } catch (error) {
        return res.status(400).json(this.createErrorResponse('CHAIN_FAILED', (error as Error).message));
      }
    });

    // ---------------- Page tools: find_similar / crawl ----------------

    // POST /v2/attach/find-similar — { selector, minScore?, limit? }
    this.app.post('/v2/attach/find-similar', async (req, res) => {
      try {
        const { selector, minScore, limit } = req.body || {};
        if (typeof selector !== 'string' || !selector) return res.status(400).json(this.createErrorResponse('BAD_INPUT', 'Provide `selector`'));
        return res.json(this.createSuccessResponse(await this.attachManager.findSimilar(selector, { minScore, limit })));
      } catch (error) {
        return res.status(400).json(this.createErrorResponse('FIND_SIMILAR_FAILED', (error as Error).message));
      }
    });

    // POST /v2/attach/crawl — { startUrl, maxPages?, maxDepth?, sameDomain?, perPageTimeoutMs? }
    this.app.post('/v2/attach/crawl', async (req, res) => {
      try {
        const { startUrl, maxPages, maxDepth, sameDomain, perPageTimeoutMs } = req.body || {};
        if (typeof startUrl !== 'string' || !startUrl) return res.status(400).json(this.createErrorResponse('BAD_INPUT', 'Provide `startUrl`'));
        return res.json(this.createSuccessResponse(await this.attachManager.crawl(startUrl, { maxPages, maxDepth, sameDomain, perPageTimeoutMs })));
      } catch (error) {
        return res.status(400).json(this.createErrorResponse('CRAWL_FAILED', (error as Error).message));
      }
    });

    // ---------------- HTTP replay ----------------

    // POST /v2/attach/replay-http — fire raw HTTP requests reusing the attached session.
    // Body: ReplayOpts { method?, url?, urls?, idRange?:{from,to,placeholder?,url?}, headers?, body?, concurrency?, maxResponses?, bodyLimit?, forceServerSide? }
    this.app.post('/v2/attach/replay-http', async (req, res) => {
      try {
        return res.json(this.createSuccessResponse(await this.attachManager.replayHttp(req.body || {})));
      } catch (error) {
        return res.status(400).json(this.createErrorResponse('REPLAY_HTTP_FAILED', (error as Error).message));
      }
    });

    // ---------------- Resource / domain blocking (speed) ----------------

    // POST /v2/attach/block-resources — install context route blocking noisy resources / ad domains.
    // Body: { enable: boolean, resourceTypes?: string[], domains?: string[], ads?: boolean }
    this.app.post('/v2/attach/block-resources', async (req, res) => {
      try {
        const { enable, resourceTypes, domains, ads } = req.body || {};
        if (enable === false) {
          return res.json(this.createSuccessResponse(await this.attachManager.unblockResources()));
        }
        return res.json(this.createSuccessResponse(await this.attachManager.blockResources({ resourceTypes, domains, ads })));
      } catch (error) {
        return res.status(400).json(this.createErrorResponse('BLOCK_RESOURCES_FAILED', (error as Error).message));
      }
    });

    // ---------------- HAR export (#6) ----------------

    // GET /v2/attach/har
    this.app.get('/v2/attach/har', (_req, res) => {
      try {
        const har = this.attachManager.toHAR();
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', 'attachment; filename="attach.har"');
        return res.send(JSON.stringify(har, null, 2));
      } catch (error) {
        return res.status(400).json(this.createErrorResponse('ATTACH_HAR_FAILED', (error as Error).message));
      }
    });

    // ============================================================
    // #4 / #22 — Named / incognito contexts
    // ============================================================

    // GET  /v2/attach/contexts                         — list
    // POST /v2/attach/contexts           {name}        — create
    // POST /v2/attach/contexts/close     {name}        — close
    // POST /v2/attach/contexts/navigate  {name,url,..} — navigate in named ctx
    // GET  /v2/attach/contexts/cookies?name=X&domain=Y&name=Z — cookies in named ctx

    this.app.get('/v2/attach/contexts', async (_req, res) => {
      try {
        const list = await this.attachManager.listContexts();
        return res.json(this.createSuccessResponse({ count: list.length, contexts: list }));
      } catch (error) {
        return res.status(400).json(this.createErrorResponse('ATTACH_CONTEXTS_LIST_FAILED', (error as Error).message));
      }
    });

    this.app.post('/v2/attach/contexts', async (req, res) => {
      try {
        const { name } = req.body || {};
        if (typeof name !== 'string' || !name) return res.status(400).json(this.createErrorResponse('NAME_REQUIRED', 'Provide `name`'));
        const info = await this.attachManager.createContext(name);
        return res.json(this.createSuccessResponse(info));
      } catch (error) {
        return res.status(400).json(this.createErrorResponse('ATTACH_CONTEXT_CREATE_FAILED', (error as Error).message));
      }
    });

    this.app.post('/v2/attach/contexts/close', async (req, res) => {
      try {
        const { name } = req.body || {};
        if (typeof name !== 'string' || !name) return res.status(400).json(this.createErrorResponse('NAME_REQUIRED', 'Provide `name`'));
        await this.attachManager.closeContext(name);
        return res.json(this.createSuccessResponse({ closed: name }));
      } catch (error) {
        return res.status(400).json(this.createErrorResponse('ATTACH_CONTEXT_CLOSE_FAILED', (error as Error).message));
      }
    });

    this.app.post('/v2/attach/contexts/navigate', async (req, res) => {
      try {
        const { name, url, waitUntil, timeout } = req.body || {};
        if (typeof name !== 'string' || !name) return res.status(400).json(this.createErrorResponse('NAME_REQUIRED', 'Provide `name`'));
        if (typeof url !== 'string' || !url) return res.status(400).json(this.createErrorResponse('URL_REQUIRED', 'Provide `url`'));
        const out = await this.attachManager.navigateContext(name, url, { waitUntil, timeout });
        return res.json(this.createSuccessResponse(out));
      } catch (error) {
        return res.status(400).json(this.createErrorResponse('ATTACH_CONTEXT_NAV_FAILED', (error as Error).message));
      }
    });

    this.app.get('/v2/attach/contexts/cookies', async (req, res) => {
      try {
        const name = typeof req.query.context === 'string' ? req.query.context : 'default';
        const domain = typeof req.query.domain === 'string' ? req.query.domain : undefined;
        const cookieName = typeof req.query.name === 'string' ? req.query.name : undefined;
        const cookies = await this.attachManager.getContextCookies(name, {
          ...(domain ? { domain } : {}),
          ...(cookieName ? { name: cookieName } : {})
        });
        return res.json(this.createSuccessResponse({ count: cookies.length, cookies }));
      } catch (error) {
        return res.status(400).json(this.createErrorResponse('ATTACH_CONTEXT_COOKIES_FAILED', (error as Error).message));
      }
    });

    // ============================================================
    // #2 — Env cookie loader
    // ============================================================

    // POST /v2/attach/cookies/load-file  {path, context?}
    // POST /v2/attach/cookies/export-file {path, context?, domain}
    this.app.post('/v2/attach/cookies/load-file', async (req, res) => {
      try {
        const { path, context = 'default' } = req.body || {};
        if (typeof path !== 'string' || !path) return res.status(400).json(this.createErrorResponse('PATH_REQUIRED', 'Provide `path`'));
        const out = await this.attachManager.loadCookiesFromFile(path, context);
        return res.json(this.createSuccessResponse(out));
      } catch (error) {
        return res.status(400).json(this.createErrorResponse('ATTACH_COOKIES_LOAD_FAILED', (error as Error).message));
      }
    });

    this.app.post('/v2/attach/cookies/export-file', async (req, res) => {
      try {
        const { path, context = 'default', domain } = req.body || {};
        if (typeof path !== 'string' || !path) return res.status(400).json(this.createErrorResponse('PATH_REQUIRED', 'Provide `path`'));
        if (typeof domain !== 'string' || !domain) return res.status(400).json(this.createErrorResponse('DOMAIN_REQUIRED', 'Provide `domain`'));
        const content = await this.attachManager.exportCookiesToEnv(context, domain);
        const fs = await import('fs/promises');
        await fs.writeFile(path, content, 'utf8');
        return res.json(this.createSuccessResponse({ path, bytes: content.length }));
      } catch (error) {
        return res.status(400).json(this.createErrorResponse('ATTACH_COOKIES_EXPORT_FAILED', (error as Error).message));
      }
    });

    // ============================================================
    // #1 / #20 — WebSocket
    // ============================================================

    // GET  /v2/attach/ws                  — list connections
    // GET  /v2/attach/ws/:id              — full detail with all frames
    // GET  /v2/attach/ws/frames?connectionId=&direction=&contains=&limit= — flat frame query
    // POST /v2/attach/ws/send {urlContains, payload, context?} — inject frame via WebSocket.send
    this.app.get('/v2/attach/ws', (_req, res) => {
      try {
        const list = this.attachManager.listWebSockets();
        return res.json(this.createSuccessResponse({ count: list.length, connections: list }));
      } catch (error) {
        return res.status(400).json(this.createErrorResponse('ATTACH_WS_LIST_FAILED', (error as Error).message));
      }
    });

    this.app.get('/v2/attach/ws/frames', (req, res) => {
      try {
        const connectionId = typeof req.query.connectionId === 'string' ? req.query.connectionId : undefined;
        const direction = (req.query.direction === 'in' || req.query.direction === 'out') ? req.query.direction : undefined;
        const contains = typeof req.query.contains === 'string' ? req.query.contains : undefined;
        const limit = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : undefined;
        const frames = this.attachManager.queryWsFrames({
          ...(connectionId ? { connectionId } : {}),
          ...(direction ? { direction } : {}),
          ...(contains ? { contains } : {}),
          ...(limit ? { limit } : {})
        });
        return res.json(this.createSuccessResponse({ count: frames.length, frames }));
      } catch (error) {
        return res.status(400).json(this.createErrorResponse('ATTACH_WS_FRAMES_FAILED', (error as Error).message));
      }
    });

    this.app.get('/v2/attach/ws/:id', (req, res) => {
      const ws = this.attachManager.getWebSocket(req.params.id);
      if (!ws) return res.status(404).json(this.createErrorResponse('WS_NOT_FOUND', 'No WebSocket connection with that id'));
      return res.json(this.createSuccessResponse(ws));
    });

    this.app.post('/v2/attach/ws/send', async (req, res) => {
      try {
        const { urlContains, payload, context = 'default' } = req.body || {};
        if (typeof urlContains !== 'string' || !urlContains) return res.status(400).json(this.createErrorResponse('URL_CONTAINS_REQUIRED', 'Provide `urlContains`'));
        if (typeof payload !== 'string') return res.status(400).json(this.createErrorResponse('PAYLOAD_REQUIRED', 'Provide string `payload`'));
        const out = await this.attachManager.sendWsFrame(urlContains, payload, context);
        return res.json(this.createSuccessResponse(out));
      } catch (error) {
        return res.status(400).json(this.createErrorResponse('ATTACH_WS_SEND_FAILED', (error as Error).message));
      }
    });

    // ============================================================
    // #3 / #23 — Intercept
    // ============================================================

    // POST /v2/attach/intercept/enable {direction, urlContains?, urlRegex?, method?}
    // GET  /v2/attach/intercept         — current rule + pending items
    // POST /v2/attach/intercept/forward {id, method?, url?, headers?, body?, status?}
    // POST /v2/attach/intercept/drop    {id}
    // POST /v2/attach/intercept/disable

    this.app.post('/v2/attach/intercept/enable', async (req, res) => {
      try {
        const { direction, urlContains, urlRegex, method } = req.body || {};
        if (direction !== 'request' && direction !== 'response' && direction !== 'both') {
          return res.status(400).json(this.createErrorResponse('DIRECTION_REQUIRED', 'direction must be request|response|both'));
        }
        await this.attachManager.enableIntercept({
          direction,
          ...(typeof urlContains === 'string' ? { urlContains } : {}),
          ...(typeof urlRegex === 'string' ? { urlRegex } : {}),
          ...(typeof method === 'string' ? { method } : {})
        });
        return res.json(this.createSuccessResponse({ enabled: true, rule: this.attachManager.getInterceptRule() }));
      } catch (error) {
        return res.status(400).json(this.createErrorResponse('ATTACH_INTERCEPT_ENABLE_FAILED', (error as Error).message));
      }
    });

    this.app.get('/v2/attach/intercept', (_req, res) => {
      try {
        return res.json(this.createSuccessResponse({
          rule: this.attachManager.getInterceptRule(),
          pending: this.attachManager.listIntercepted()
        }));
      } catch (error) {
        return res.status(400).json(this.createErrorResponse('ATTACH_INTERCEPT_GET_FAILED', (error as Error).message));
      }
    });

    this.app.post('/v2/attach/intercept/forward', async (req, res) => {
      try {
        const { id, method, url, headers, body, status } = req.body || {};
        if (typeof id !== 'string' || !id) return res.status(400).json(this.createErrorResponse('ID_REQUIRED', 'Provide `id`'));
        await this.attachManager.forwardIntercepted(id, {
          ...(typeof method === 'string' ? { method } : {}),
          ...(typeof url === 'string' ? { url } : {}),
          ...(headers && typeof headers === 'object' ? { headers } : {}),
          ...(typeof body === 'string' ? { body } : {}),
          ...(typeof status === 'number' ? { status } : {})
        });
        return res.json(this.createSuccessResponse({ forwarded: id }));
      } catch (error) {
        return res.status(400).json(this.createErrorResponse('ATTACH_INTERCEPT_FORWARD_FAILED', (error as Error).message));
      }
    });

    this.app.post('/v2/attach/intercept/drop', async (req, res) => {
      try {
        const { id } = req.body || {};
        if (typeof id !== 'string' || !id) return res.status(400).json(this.createErrorResponse('ID_REQUIRED', 'Provide `id`'));
        await this.attachManager.dropIntercepted(id);
        return res.json(this.createSuccessResponse({ dropped: id }));
      } catch (error) {
        return res.status(400).json(this.createErrorResponse('ATTACH_INTERCEPT_DROP_FAILED', (error as Error).message));
      }
    });

    this.app.post('/v2/attach/intercept/disable', async (_req, res) => {
      try {
        await this.attachManager.disableIntercept();
        return res.json(this.createSuccessResponse({ disabled: true }));
      } catch (error) {
        return res.status(400).json(this.createErrorResponse('ATTACH_INTERCEPT_DISABLE_FAILED', (error as Error).message));
      }
    });

    // Session metrics
    this.app.get('/v2/sessions/:sessionId/metrics', (req, res) => {
      const metrics = this.sessionManager.getSessionMetrics(req.params.sessionId);
      if (!metrics) {
        return res.status(404).json(this.createErrorResponse('SESSION_NOT_FOUND', 'Session not found'));
      }

      return res.json(this.createSuccessResponse(metrics));
    });

    // Destroy session
    this.app.delete('/v2/sessions/:sessionId', async (req, res) => {
      try {
        await this.sessionManager.destroySession(req.params.sessionId);
        res.json(this.createSuccessResponse({ destroyed: true }));
      } catch (error) {
        res.status(400).json(this.createErrorResponse('SESSION_DESTROY_FAILED', (error as Error).message));
      }
    });

    // Plugin management
    this.app.get('/v2/plugins', (req, res) => {
      const plugins = this.pluginManager.getPluginStatus();
      res.json(this.createSuccessResponse({
        plugins,
        total: plugins.length,
        enabled: plugins.filter(p => p.enabled).length
      }));
    });

    // Enable/disable plugin
    this.app.post('/v2/plugins/:pluginName/toggle', async (req, res) => {
      try {
        const { pluginName } = req.params;
        const { enable } = req.body;

        if (enable) {
          await this.pluginManager.enable(pluginName);
        } else {
          await this.pluginManager.disable(pluginName);
        }

        res.json(this.createSuccessResponse({
          plugin: pluginName,
          enabled: enable,
          toggled: true
        }));
      } catch (error) {
        res.status(400).json(this.createErrorResponse('PLUGIN_TOGGLE_FAILED', (error as Error).message));
      }
    });

    // System metrics
    this.app.get('/v2/metrics', (req, res) => {
      const metrics = {
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        sessions: this.sessionManager.getSessionsHealth(),
        browser: (this.sessionManager as any).browserManager.health(),
        plugins: this.pluginManager.getPluginStatus()
      };

      res.json(this.createSuccessResponse(metrics));
    });

    // V1 compatibility routes (for migration)
    this.setupV1CompatibilityRoutes();
  }

  private setupV1CompatibilityRoutes(): void {
    // Redirect V1 routes to V2
    this.app.use('/session', (req, res, next) => {
      Logger.warn('Deprecated V1 API used, redirecting to V2', {
        originalUrl: req.originalUrl,
        method: req.method
      });

      // Simple redirect logic - more sophisticated mapping would be in actual compatibility layer
      if (req.method === 'POST' && req.path === '/') {
        return res.redirect(307, '/v2/sessions');
      }

      next();
    });
  }

  private setupErrorHandling(): void {
    // 404 handler
    this.app.use('*', (req, res) => {
      res.status(404).json(this.createErrorResponse('NOT_FOUND', `Endpoint not found: ${req.method} ${req.path}`));
    });

    // Global error handler
    this.app.use((error: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
      Logger.error('Unhandled API error', error, {
        method: req.method,
        path: req.path,
        body: req.body
      });

      res.status(500).json(this.createErrorResponse('INTERNAL_ERROR', 'Internal server error'));
    });
  }

  private createSuccessResponse<T>(data: T): ApiResponse<T> {
    return {
      success: true,
      data,
      timestamp: new Date(),
      duration: 0 // Would be calculated with request timing
    };
  }

  private createErrorResponse(code: string, message: string, details?: any): ApiResponse {
    return {
      success: false,
      error: {
        code,
        message,
        details
      },
      timestamp: new Date(),
      duration: 0
    };
  }
}

export default HTTPServer;