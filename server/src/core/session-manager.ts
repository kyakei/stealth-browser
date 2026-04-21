import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs/promises';
import { BrowserContext, Page } from 'playwright';
import {
  Session,
  SessionOptions,
  SessionMetadata,
  SessionState,
  SessionConfig,
  SessionMetrics
} from '@utils/types';
import { Logger } from '@utils/logger';
import ConfigManager from './config-manager';
import BrowserManager from './browser-manager';
import PluginManager from './plugin-manager';
import { NetworkLogger } from './network-logger';

export class SessionManager extends EventEmitter {
  /**
   * Lowercase header names that the built-in auth-header sniffer watches for.
   * Playwright request.headers() returns all keys lowercased, so we match on
   * lowercased names directly.
   */
  public static readonly AUTH_HEADER_ALLOWLIST: readonly string[] = [
    'authorization',
    'token',
    'fingerprint',
    'x-csrf-token',
    'x-auth-token',
    'x-access-token',
    'x-api-key',
    'x-operation-id',
    'operation-id',
    'x-session-id',
    'x-hackerone',
    'x-bugcrowd'
  ] as const;

  private sessions: Map<string, Session> = new Map();
  private networkLoggers: Map<string, NetworkLogger> = new Map();
  private config: SessionConfig;
  private browserManager: BrowserManager;
  private pluginManager: PluginManager;
  private isInitialized = false;
  private cleanupInterval: NodeJS.Timeout | null = null;
  private metricsInterval: NodeJS.Timeout | null = null;

  constructor(browserManager: BrowserManager, pluginManager: PluginManager) {
    super();
    this.config = ConfigManager.getInstance().get<SessionConfig>('sessions');
    this.browserManager = browserManager;
    this.pluginManager = pluginManager;

    this.setupCleanupIntervals();
    this.setupEventHandlers();
  }

  public async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    Logger.info('Initializing Session Manager', {
      maxConcurrent: this.config.maxConcurrent,
      persistenceEnabled: this.config.persistenceEnabled,
      stateDirectory: this.config.stateDirectory
    });

    // Ensure state directory exists
    if (this.config.persistenceEnabled) {
      try {
        await fs.mkdir(this.config.stateDirectory, { recursive: true });
      } catch (error) {
        Logger.error('Failed to create state directory', error);
      }
    }

    // Restore persisted sessions
    if (this.config.persistenceEnabled) {
      await this.restorePersistedSessions();
    }

    this.isInitialized = true;
    this.emit('initialized');
    Logger.info(`Session Manager initialized with ${this.sessions.size} sessions`);
  }

  public async createSession(options: SessionOptions = {}): Promise<Session> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    // Check concurrent session limit
    if (this.sessions.size >= this.config.maxConcurrent) {
      throw new Error(`Maximum concurrent sessions reached: ${this.config.maxConcurrent}`);
    }

    const sessionId = uuidv4();

    Logger.info(`Creating session: ${sessionId}`, options);

    try {
      // Get browser instance
      const browserInstance = await this.browserManager.acquire();

      // Create browser context with options
      const contextOptions = {
        viewport: options.viewport || { width: 1366, height: 768 },
        userAgent: options.userAgent,
        locale: options.locale || 'en-US',
        timezoneId: options.timezone || 'America/New_York',
        geolocation: options.geolocation,
        permissions: options.permissions,
        storageState: options.storageState ? await this.loadStorageState(options.storageState) : undefined,
      };

      const context = await this.browserManager.createContext(browserInstance, contextOptions);

      // Execute plugin hooks before page creation
      await this.pluginManager.executeHook('beforePageCreate', null as any, context);

      // Create page
      const page = await context.newPage();

      // Set up page event handlers
      this.setupPageEventHandlers(page, sessionId);

      // Execute plugin hooks after page creation
      await this.pluginManager.executeHook('afterPageCreate', null as any, page);

      // Create session metadata
      const metadata: SessionMetadata = {
        id: sessionId,
        createdAt: new Date(),
        lastActivity: new Date(),
        userAgent: options.userAgent || contextOptions.userAgent || 'unknown',
        viewport: contextOptions.viewport,
        plugins: options.plugins || [],
        persistent: options.persistent || false,
        tags: options.tags || []
      };

      // Initialize session metrics
      const metrics: SessionMetrics = {
        requests: 0,
        responses: 0,
        errors: 0,
        averageResponseTime: 0,
        networkData: { bytesReceived: 0, bytesSent: 0 },
        pageMetrics: { loadTime: 0, domContentLoaded: 0 },
        interactions: { clicks: 0, keystrokes: 0, scrolls: 0, navigations: 0 }
      };

      // Create session object
      const session: Session = {
        id: sessionId,
        context,
        page,
        metadata,
        plugins: new Map(),
        metrics,
        isActive: true,
        createdAt: new Date(),
        lastActivity: new Date(),
        capturedHeaders: new Map(),
        pluginStore: new Map()
      };

      // Store session
      this.sessions.set(sessionId, session);

      // Attach per-session network logger BEFORE page events fire. The logger
      // owns its own disk handle; we just hand it the page to wire listeners.
      const netLogger = new NetworkLogger(sessionId);
      netLogger.attach(page);
      this.networkLoggers.set(sessionId, netLogger);

      // Add session to browser instance
      await this.browserManager.addSession(browserInstance.id, session);

      this.emit('sessionCreated', session);
      Logger.session(sessionId, 'Session created successfully', {
        browserInstance: browserInstance.id,
        options
      });

      return session;
    } catch (error) {
      Logger.error(`Failed to create session: ${sessionId}`, error);
      throw error;
    }
  }

  public async destroySession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      Logger.warn(`Attempted to destroy unknown session: ${sessionId}`);
      return;
    }

    Logger.info(`Destroying session: ${sessionId}`);

    try {
      // Persist session state if enabled
      if (this.config.persistenceEnabled && session.metadata.persistent) {
        await this.persistSessionState(session);
      }

      // Close page and context
      if (session.page && !session.page.isClosed()) {
        await session.page.close();
      }

      if (session.context) {
        await session.context.close();
      }

      // Flush/close the network logger — fire-and-forget so a broken stream
      // doesn't block session teardown.
      const netLogger = this.networkLoggers.get(sessionId);
      if (netLogger) {
        this.networkLoggers.delete(sessionId);
        netLogger.close().catch(err => Logger.error(`Network logger close error for ${sessionId}`, err));
      }

      // Mark as inactive
      session.isActive = false;

      // Remove from sessions map
      this.sessions.delete(sessionId);

      // Remove from browser instance
      const browserInstances = this.browserManager.instances;
      for (const [instanceId, instance] of browserInstances) {
        if (instance.sessions.has(sessionId)) {
          await this.browserManager.removeSession(instanceId, sessionId);
          break;
        }
      }

      this.emit('sessionDestroyed', session);
      Logger.session(sessionId, 'Session destroyed successfully');

    } catch (error) {
      Logger.error(`Error destroying session: ${sessionId}`, error);
      throw error;
    }
  }

  public getSession(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  public getAllSessions(): Session[] {
    return Array.from(this.sessions.values());
  }

  public getActiveSessions(): Session[] {
    return Array.from(this.sessions.values()).filter(session => session.isActive);
  }

  public getSessionsByTag(tag: string): Session[] {
    return Array.from(this.sessions.values())
      .filter(session => session.metadata.tags.includes(tag));
  }

  public updateSessionActivity(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.lastActivity = new Date();
      session.metadata.lastActivity = new Date();
    }
  }

  public async persistSessionState(session: Session): Promise<string> {
    if (!this.config.persistenceEnabled) {
      throw new Error('Session persistence is not enabled');
    }

    const statePath = path.join(this.config.stateDirectory, `${session.id}.json`);

    try {
      // Get browser state
      const storageState = await session.context.storageState();

      // Create session state object
      const sessionState: SessionState = {
        cookies: storageState.cookies,
        localStorage: storageState.origins?.[0]?.localStorage || [],
        sessionStorage: [], // sessionStorage is not available in Playwright's storageState
        url: session.page.url(),
        metadata: session.metadata
      };

      // Write to file
      await fs.writeFile(statePath, JSON.stringify(sessionState, null, 2));

      Logger.session(session.id, 'Session state persisted', { statePath });
      return statePath;

    } catch (error) {
      Logger.error(`Failed to persist session state: ${session.id}`, error);
      throw error;
    }
  }

  public async loadSessionState(sessionId: string): Promise<SessionState | null> {
    if (!this.config.persistenceEnabled) {
      return null;
    }

    const statePath = path.join(this.config.stateDirectory, `${sessionId}.json`);

    try {
      const stateData = await fs.readFile(statePath, 'utf8');
      const sessionState: SessionState = JSON.parse(stateData);

      Logger.session(sessionId, 'Session state loaded', { statePath });
      return sessionState;

    } catch (error) {
      if ((error as any).code !== 'ENOENT') {
        Logger.error(`Failed to load session state: ${sessionId}`, error);
      }
      return null;
    }
  }

  public async restoreSession(sessionId: string, options: SessionOptions = {}): Promise<Session> {
    const sessionState = await this.loadSessionState(sessionId);
    if (!sessionState) {
      throw new Error(`No persisted state found for session: ${sessionId}`);
    }

    // Create new session with persisted state
    const storageStatePath = path.join(this.config.stateDirectory, `${sessionId}-storage.json`);
    await fs.writeFile(storageStatePath, JSON.stringify({
      cookies: sessionState.cookies,
      origins: [{
        origin: new URL(sessionState.url).origin,
        localStorage: sessionState.localStorage,
        sessionStorage: sessionState.sessionStorage
      }]
    }));

    const session = await this.createSession({
      ...options,
      storageState: storageStatePath,
      persistent: true
    });

    // Navigate to the last URL
    if (sessionState.url) {
      await session.page.goto(sessionState.url);
    }

    Logger.session(session.id, 'Session restored from state', {
      originalSessionId: sessionId,
      url: sessionState.url
    });

    return session;
  }

  public getSessionMetrics(sessionId: string): SessionMetrics | null {
    const session = this.sessions.get(sessionId);
    return session ? session.metrics : null;
  }

  /**
   * Return all auth-like headers captured on the session so far.
   * Optionally filter to a specific host.
   */
  /**
   * Return the NetworkLogger associated with a session, if any. HTTP server
   * routes use this to query / fetch individual entries / emit HAR.
   */
  public getNetworkLogger(sessionId: string): NetworkLogger | undefined {
    return this.networkLoggers.get(sessionId);
  }

  public getCapturedHeaders(
    sessionId: string,
    hostFilter?: string
  ): Array<{ host: string; header: string; value: string; url: string; method: string; capturedAt: Date }> {
    const session = this.sessions.get(sessionId);
    if (!session) return [];
    const out: Array<{ host: string; header: string; value: string; url: string; method: string; capturedAt: Date }> = [];
    for (const captured of session.capturedHeaders.values()) {
      if (hostFilter && captured.host !== hostFilter) continue;
      out.push({
        host: captured.host,
        header: captured.header,
        value: captured.value,
        url: captured.url,
        method: captured.method,
        capturedAt: captured.capturedAt
      });
    }
    return out.sort((a, b) => b.capturedAt.getTime() - a.capturedAt.getTime());
  }

  /**
   * Import cookies into a session's browser context. Accepts Playwright cookie
   * objects directly. Missing `domain` falls back to the session page's current host.
   */
  public async importCookies(
    sessionId: string,
    cookies: Array<{
      name: string;
      value: string;
      domain?: string;
      path?: string;
      expires?: number;
      httpOnly?: boolean;
      secure?: boolean;
      sameSite?: 'Strict' | 'Lax' | 'None';
    }>
  ): Promise<number> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);

    // Derive a fallback domain from the current page URL if caller didn't provide one.
    let fallbackDomain: string | undefined;
    try {
      const u = new URL(session.page.url());
      fallbackDomain = '.' + u.hostname.replace(/^www\./, '');
    } catch {
      // no page URL yet — caller must supply domains explicitly
    }

    const normalized = cookies
      .filter(c => c.name && c.value !== undefined)
      .map(c => ({
        name: c.name,
        value: String(c.value),
        domain: c.domain || fallbackDomain,
        path: c.path || '/',
        ...(c.expires != null ? { expires: c.expires } : {}),
        httpOnly: c.httpOnly ?? true,
        secure: c.secure ?? true,
        sameSite: c.sameSite || 'Lax' as const
      }))
      .filter(c => c.domain); // drop entries we couldn't resolve a domain for

    if (normalized.length === 0) {
      throw new Error('No valid cookies to import (missing name/value/domain)');
    }

    await session.context.addCookies(normalized as any);
    this.updateSessionActivity(sessionId);
    Logger.session(sessionId, 'Cookies imported', { count: normalized.length });
    return normalized.length;
  }

  public getAllSessionsMetrics(): Record<string, SessionMetrics> {
    const metrics: Record<string, SessionMetrics> = {};
    for (const [sessionId, session] of this.sessions) {
      metrics[sessionId] = session.metrics;
    }
    return metrics;
  }

  public getSessionsHealth(): {
    total: number;
    active: number;
    expired: number;
    averageAge: number;
  } {
    const now = Date.now();
    let active = 0;
    let expired = 0;
    let totalAge = 0;

    for (const session of this.sessions.values()) {
      const age = now - session.createdAt.getTime();
      const lastActivity = now - session.lastActivity.getTime();

      totalAge += age;

      if (session.isActive && lastActivity < this.config.maxAge) {
        active++;
      } else {
        expired++;
      }
    }

    return {
      total: this.sessions.size,
      active,
      expired,
      averageAge: this.sessions.size > 0 ? totalAge / this.sessions.size : 0
    };
  }

  private async loadStorageState(statePath: string): Promise<any> {
    try {
      const stateData = await fs.readFile(statePath, 'utf8');
      return JSON.parse(stateData);
    } catch (error) {
      Logger.error(`Failed to load storage state: ${statePath}`, error);
      return undefined;
    }
  }

  private async restorePersistedSessions(): Promise<void> {
    try {
      const stateFiles = await fs.readdir(this.config.stateDirectory);
      const sessionFiles = stateFiles.filter(file =>
        file.endsWith('.json') && !file.includes('-storage')
      );

      Logger.info(`Found ${sessionFiles.length} persisted sessions to restore`);

      for (const file of sessionFiles) {
        const sessionId = path.basename(file, '.json');
        try {
          // For now, just log that sessions are available for restoration
          // Actual restoration can be triggered via API
          Logger.debug(`Persisted session available: ${sessionId}`);
        } catch (error) {
          Logger.error(`Failed to restore session: ${sessionId}`, error);
        }
      }
    } catch (error) {
      Logger.error('Failed to restore persisted sessions', error);
    }
  }

  private setupPageEventHandlers(page: Page, sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // Request handler
    page.on('request', async (request) => {
      session.metrics.requests++;
      this.updateSessionActivity(sessionId);

      // Auth-header sniffer: persist last-seen values of interesting headers per host.
      // Rapyd uses `token` + `fingerprint`; most apps use `authorization`. Add to this
      // allowlist as we learn about new programs.
      try {
        const headers = request.headers();
        const url = request.url();
        const host = new URL(url).host;
        for (const headerName of SessionManager.AUTH_HEADER_ALLOWLIST) {
          const value = headers[headerName];
          if (value && typeof value === 'string' && value.length > 0) {
            session.capturedHeaders.set(`${host}|${headerName}`, {
              host,
              header: headerName,
              value,
              url,
              method: request.method(),
              capturedAt: new Date()
            });
          }
        }
      } catch {
        // URL parse failure or header read error — ignore, best-effort capture
      }

      // Execute plugin hook
      await this.pluginManager.executeHook('onRequest', session, request);

      Logger.debug(`Request: ${request.method()} ${request.url()}`, {
        sessionId,
        resourceType: request.resourceType()
      });
    });

    // Response handler
    page.on('response', async (response) => {
      session.metrics.responses++;
      this.updateSessionActivity(sessionId);

      // Response timing is not available in Playwright's Response API
      // We could implement custom timing if needed

      // Execute plugin hook
      await this.pluginManager.executeHook('onResponse', session, response);

      Logger.debug(`Response: ${response.status()} ${response.url()}`, {
        sessionId
      });
    });

    // Error handler
    page.on('pageerror', (error) => {
      session.metrics.errors++;
      Logger.error(`Page error in session ${sessionId}`, error);
    });

    // Console handler
    page.on('console', (message) => {
      Logger.debug(`Console [${message.type()}]: ${message.text()}`, {
        sessionId
      });
    });

    // Load handler
    page.on('load', () => {
      session.metrics.interactions.navigations++;
      this.updateSessionActivity(sessionId);

      Logger.debug(`Page loaded: ${page.url()}`, { sessionId });
    });
  }

  private setupEventHandlers(): void {
    // Listen for configuration changes
    ConfigManager.getInstance().subscribe('config.changed', (config) => {
      this.config = config.sessions;
      Logger.info('Session configuration updated');
    });
  }

  private setupCleanupIntervals(): void {
    // Cleanup expired sessions every minute
    this.cleanupInterval = setInterval(() => {
      this.cleanupExpiredSessions();
    }, 60 * 1000);

    // Update metrics every 30 seconds
    this.metricsInterval = setInterval(() => {
      this.updateMetrics();
    }, 30 * 1000);
  }

  private async cleanupExpiredSessions(): Promise<void> {
    const now = Date.now();
    const expiredSessions: string[] = [];

    for (const [sessionId, session] of this.sessions) {
      const lastActivity = now - session.lastActivity.getTime();
      if (lastActivity > this.config.maxAge) {
        expiredSessions.push(sessionId);
      }
    }

    for (const sessionId of expiredSessions) {
      try {
        await this.destroySession(sessionId);
      } catch (error) {
        Logger.error(`Failed to cleanup expired session: ${sessionId}`, error);
      }
    }

    if (expiredSessions.length > 0) {
      Logger.info(`Cleaned up ${expiredSessions.length} expired sessions`);
    }
  }

  private updateMetrics(): void {
    const health = this.getSessionsHealth();
    this.emit('metricsUpdated', health);

    Logger.debug('Session metrics updated', health);
  }

  public async shutdown(): Promise<void> {
    Logger.info('Shutting down Session Manager');

    // Clear intervals
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    if (this.metricsInterval) {
      clearInterval(this.metricsInterval);
    }

    // Destroy all sessions
    const sessionIds = Array.from(this.sessions.keys());
    const destroyPromises = sessionIds.map(sessionId => this.destroySession(sessionId));
    await Promise.allSettled(destroyPromises);

    this.sessions.clear();
    this.emit('shutdown');
    Logger.info('Session Manager shutdown complete');
  }
}

export default SessionManager;