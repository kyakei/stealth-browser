import { firefox, webkit, Browser, BrowserContext } from 'playwright';
import { chromium as chromiumExtra } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { v4 as uuidv4 } from 'uuid';
import { EventEmitter } from 'events';
import { BrowserInstance, BrowserPool, BrowserConfig, Session } from '@utils/types';
import { Logger } from '@utils/logger';
import ConfigManager from './config-manager';

// Register the stealth plugin once at module load; covers ~17 evasions (webdriver,
// chrome.runtime, CDP fingerprint, WebGL vendor, iframe contentWindow, media codecs,
// navigator.permissions, etc.). Keeps our own stealth-injector plugin as an additive
// layer for fingerprint randomization.
chromiumExtra.use(StealthPlugin());

export class BrowserManager extends EventEmitter implements BrowserPool {
  public instances: Map<string, BrowserInstance> = new Map();
  private config: BrowserConfig;
  private isInitialized = false;
  private cleanupInterval: NodeJS.Timeout | null = null;
  private healthCheckInterval: NodeJS.Timeout | null = null;

  constructor() {
    super();
    this.config = ConfigManager.getInstance().get<BrowserConfig>('browser');
    this.setupCleanupIntervals();
  }

  public async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    Logger.info('Initializing Browser Manager', {
      engine: this.config.engine,
      poolSize: `${this.config.pool.min}-${this.config.pool.max}`,
      headless: this.config.headless
    });

    // Pre-create minimum browser instances
    for (let i = 0; i < this.config.pool.min; i++) {
      try {
        await this.createBrowserInstance();
      } catch (error) {
        Logger.error(`Failed to create initial browser instance ${i + 1}`, error);
      }
    }

    this.isInitialized = true;
    this.emit('initialized');
    Logger.info(`Browser Manager initialized with ${this.instances.size} instances`);
  }

  public async acquire(): Promise<BrowserInstance> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    // Try to find an available instance
    let availableInstance = this.findAvailableInstance();

    // If no available instance and under max limit, create new one
    if (!availableInstance && this.instances.size < this.config.pool.max) {
      try {
        availableInstance = await this.createBrowserInstance();
      } catch (error) {
        Logger.error('Failed to create new browser instance on demand', error);
      }
    }

    // If still no instance, wait for one to become available
    if (!availableInstance) {
      availableInstance = await this.waitForAvailableInstance();
    }

    availableInstance.lastUsed = new Date();
    this.emit('instanceAcquired', availableInstance.id);

    Logger.debug(`Browser instance acquired: ${availableInstance.id}`, {
      totalInstances: this.instances.size,
      activeSessions: availableInstance.sessions.size
    });

    return availableInstance;
  }

  public async release(id: string): Promise<void> {
    const instance = this.instances.get(id);
    if (!instance) {
      Logger.warn(`Attempted to release unknown browser instance: ${id}`);
      return;
    }

    instance.lastUsed = new Date();
    this.emit('instanceReleased', id);

    Logger.debug(`Browser instance released: ${id}`, {
      activeSessions: instance.sessions.size
    });

    // If instance has no active sessions and we're over minimum, consider cleanup
    if (instance.sessions.size === 0 && this.instances.size > this.config.pool.min) {
      const idleTime = Date.now() - instance.lastUsed.getTime();
      if (idleTime > this.config.pool.idleTimeout) {
        await this.destroy(id);
      }
    }
  }

  public async destroy(id: string): Promise<void> {
    const instance = this.instances.get(id);
    if (!instance) {
      Logger.warn(`Attempted to destroy unknown browser instance: ${id}`);
      return;
    }

    Logger.info(`Destroying browser instance: ${id}`, {
      sessionsToClose: instance.sessions.size
    });

    // Close all sessions in this instance
    const sessionPromises = Array.from(instance.sessions.values()).map(session =>
      this.closeSession(session)
    );
    await Promise.allSettled(sessionPromises);

    // Close the browser
    try {
      if (instance.browser && instance.browser.isConnected()) {
        await instance.browser.close();
      }
    } catch (error) {
      Logger.error(`Error closing browser instance ${id}`, error);
    }

    this.instances.delete(id);
    this.emit('instanceDestroyed', id);

    Logger.info(`Browser instance destroyed: ${id}`);
  }

  public health(): { total: number; active: number; healthy: number } {
    let healthy = 0;
    let active = 0;

    for (const instance of this.instances.values()) {
      if (instance.sessions.size > 0) {
        active++;
      }
      if (instance.isHealthy && instance.browser.isConnected()) {
        healthy++;
      }
    }

    return {
      total: this.instances.size,
      active,
      healthy
    };
  }

  public async createContext(
    instance: BrowserInstance,
    options: any = {}
  ): Promise<BrowserContext> {
    const contextOptions = {
      viewport: { width: 1366, height: 768 },
      userAgent: this.generateUserAgent(),
      locale: 'en-US',
      timezoneId: 'America/New_York',
      ...options
    };

    const context = await instance.browser.newContext(contextOptions);

    // Add request/response logging
    context.on('request', (request) => {
      Logger.debug(`Request: ${request.method()} ${request.url()}`, {
        instanceId: instance.id,
        resourceType: request.resourceType()
      });
    });

    context.on('response', (response) => {
      Logger.debug(`Response: ${response.status()} ${response.url()}`, {
        instanceId: instance.id
      });
    });

    return context;
  }

  public async addSession(instanceId: string, session: Session): Promise<void> {
    const instance = this.instances.get(instanceId);
    if (!instance) {
      throw new Error(`Browser instance not found: ${instanceId}`);
    }

    instance.sessions.set(session.id, session);
    this.emit('sessionAdded', { instanceId, sessionId: session.id });

    Logger.debug(`Session added to browser instance`, {
      instanceId,
      sessionId: session.id,
      totalSessions: instance.sessions.size
    });
  }

  public async removeSession(instanceId: string, sessionId: string): Promise<void> {
    const instance = this.instances.get(instanceId);
    if (!instance) {
      Logger.warn(`Browser instance not found for session removal: ${instanceId}`);
      return;
    }

    const session = instance.sessions.get(sessionId);
    if (session) {
      await this.closeSession(session);
      instance.sessions.delete(sessionId);
      this.emit('sessionRemoved', { instanceId, sessionId });

      Logger.debug(`Session removed from browser instance`, {
        instanceId,
        sessionId,
        remainingSessions: instance.sessions.size
      });
    }
  }

  private async createBrowserInstance(): Promise<BrowserInstance> {
    const id = uuidv4();

    Logger.debug(`Creating new browser instance: ${id}`);

    let browser: Browser;
    try {
      switch (this.config.engine) {
        case 'chromium':
          browser = (await chromiumExtra.launch({
            headless: this.config.headless,
            ...(this.config.executablePath && { executablePath: this.config.executablePath }),
            args: this.config.args,
          })) as unknown as Browser;
          break;
        case 'firefox':
          browser = await firefox.launch({
            headless: this.config.headless,
            ...(this.config.executablePath && { executablePath: this.config.executablePath }),
            args: this.config.args,
          });
          break;
        case 'webkit':
          browser = await webkit.launch({
            headless: this.config.headless,
            ...(this.config.executablePath && { executablePath: this.config.executablePath }),
          });
          break;
        default:
          throw new Error(`Unsupported browser engine: ${this.config.engine}`);
      }
    } catch (error) {
      Logger.error(`Failed to launch browser instance ${id}`, error);
      throw error;
    }

    const instance: BrowserInstance = {
      id,
      browser,
      sessions: new Map(),
      createdAt: new Date(),
      lastUsed: new Date(),
      isHealthy: true
    };

    this.instances.set(id, instance);
    this.emit('instanceCreated', id);

    Logger.info(`Browser instance created: ${id}`, {
      engine: this.config.engine,
      processId: (browser as any).process?.()?.pid
    });

    // Set up browser event handlers
    browser.on('disconnected', () => {
      Logger.warn(`Browser instance disconnected: ${id}`);
      instance.isHealthy = false;
      this.emit('instanceDisconnected', id);
    });

    return instance;
  }

  private findAvailableInstance(): BrowserInstance | null {
    for (const instance of this.instances.values()) {
      if (instance.isHealthy &&
          instance.browser.isConnected() &&
          instance.sessions.size < 10) { // Max sessions per instance
        return instance;
      }
    }
    return null;
  }

  private async waitForAvailableInstance(): Promise<BrowserInstance> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Timeout waiting for available browser instance'));
      }, this.config.pool.acquireTimeout);

      const checkAvailable = () => {
        const instance = this.findAvailableInstance();
        if (instance) {
          clearTimeout(timeout);
          resolve(instance);
        } else {
          // Check again in 100ms
          setTimeout(checkAvailable, 100);
        }
      };

      checkAvailable();
    });
  }

  private async closeSession(session: Session): Promise<void> {
    try {
      if (session.page && !session.page.isClosed()) {
        await session.page.close();
      }
      if (session.context) {
        await session.context.close();
      }
    } catch (error) {
      Logger.error(`Error closing session ${session.id}`, error);
    }
  }

  private generateUserAgent(): string {
    const userAgents = [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:121.0) Gecko/20100101 Firefox/121.0'
    ];

    return userAgents[Math.floor(Math.random() * userAgents.length)] as string;
  }

  private setupCleanupIntervals(): void {
    // Cleanup idle instances every 5 minutes
    this.cleanupInterval = setInterval(async () => {
      await this.cleanupIdleInstances();
    }, 5 * 60 * 1000);

    // Health check every minute
    this.healthCheckInterval = setInterval(() => {
      this.performHealthCheck();
    }, 60 * 1000);
  }

  private async cleanupIdleInstances(): Promise<void> {
    const now = Date.now();
    const instancesToDestroy: string[] = [];

    for (const [id, instance] of this.instances) {
      const idleTime = now - instance.lastUsed.getTime();
      const hasNoSessions = instance.sessions.size === 0;
      const isOverMinimum = this.instances.size > this.config.pool.min;

      if (hasNoSessions && isOverMinimum && idleTime > this.config.pool.idleTimeout) {
        instancesToDestroy.push(id);
      }
    }

    for (const id of instancesToDestroy) {
      await this.destroy(id);
    }

    if (instancesToDestroy.length > 0) {
      Logger.info(`Cleaned up ${instancesToDestroy.length} idle browser instances`);
    }
  }

  private performHealthCheck(): void {
    for (const [id, instance] of this.instances) {
      const wasHealthy = instance.isHealthy;
      instance.isHealthy = instance.browser.isConnected();

      if (wasHealthy && !instance.isHealthy) {
        Logger.warn(`Browser instance became unhealthy: ${id}`);
        this.emit('instanceUnhealthy', id);
      } else if (!wasHealthy && instance.isHealthy) {
        Logger.info(`Browser instance recovered: ${id}`);
        this.emit('instanceHealthy', id);
      }
    }
  }

  public async shutdown(): Promise<void> {
    Logger.info('Shutting down Browser Manager');

    // Clear intervals
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }

    // Close all browser instances
    const destroyPromises = Array.from(this.instances.keys()).map(id => this.destroy(id));
    await Promise.allSettled(destroyPromises);

    this.instances.clear();
    this.emit('shutdown');
    Logger.info('Browser Manager shutdown complete');
  }
}

export default BrowserManager;