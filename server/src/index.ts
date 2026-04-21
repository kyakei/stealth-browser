#!/usr/bin/env node
/**
 * Stealth Browser V2 - Enhanced Playwright-based browser automation
 * with advanced stealth capabilities and plugin architecture.
 *
 * Entry point for the application.
 */

import { EventEmitter } from 'events';
import gracefulShutdown from 'http-graceful-shutdown';
import { Logger } from './utils/logger';
import { AppConfig } from './utils/types';
import ConfigManager from './core/config-manager';
import BrowserManager from './core/browser-manager';
import PluginManager from './core/plugin-manager';
import SessionManager from './core/session-manager';
import { DisplayManager } from './core/display-manager';
import { AttachManager } from './core/attach-manager';
import { HTTPServer } from './api/http-server';
import { WebSocketServer } from './api/websocket-server';

class StealthBrowserApp extends EventEmitter {
  private config: AppConfig;
  private configManager: ConfigManager;
  private browserManager: BrowserManager;
  private pluginManager: PluginManager;
  private sessionManager: SessionManager;
  private displayManager: DisplayManager;
  private attachManager: AttachManager;
  private httpServer: HTTPServer;
  private websocketServer: WebSocketServer | null = null;
  private isInitialized = false;
  private isShuttingDown = false;

  constructor() {
    super();

    // Initialize configuration first
    this.configManager = ConfigManager.getInstance();
    this.config = this.configManager.getConfig();

    // Initialize logger
    Logger.initialize(this.config.logging);

    Logger.info('Stealth Browser V2 starting up', {
      version: '2.0.0',
      environment: this.configManager.getEnvironment(),
      nodeVersion: process.version
    });

    // Initialize core components
    this.browserManager = new BrowserManager();
    this.pluginManager = new PluginManager();
    this.sessionManager = new SessionManager(this.browserManager, this.pluginManager);
    this.displayManager = new DisplayManager();
    this.attachManager = new AttachManager();
    this.httpServer = new HTTPServer(this.sessionManager, this.pluginManager, this.displayManager, this.attachManager);

    // Setup event handlers
    this.setupEventHandlers();

    // Setup process handlers
    this.setupProcessHandlers();
  }

  public async initialize(): Promise<void> {
    if (this.isInitialized) {
      Logger.warn('Application already initialized');
      return;
    }

    try {
      Logger.info('Initializing Stealth Browser V2 components');

      // Initialize components in order
      await this.initializeBrowserManager();
      await this.initializePluginManager();
      await this.initializeSessionManager();
      await this.initializeServers();

      this.isInitialized = true;
      this.emit('initialized');

      Logger.info('Stealth Browser V2 initialized successfully', {
        httpPort: this.config.server.http.port,
        websocketEnabled: this.config.server.websocket.enabled,
        pluginsLoaded: this.pluginManager.getAll().length,
        browserInstances: this.browserManager.health().total
      });

    } catch (error) {
      Logger.error('Failed to initialize Stealth Browser V2', error);
      throw error;
    }
  }

  public async start(): Promise<void> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    try {
      Logger.info('Starting Stealth Browser V2 servers');

      // Start HTTP server
      await this.httpServer.start();

      // Start WebSocket server if enabled
      if (this.config.server.websocket.enabled) {
        this.websocketServer = new WebSocketServer(this.sessionManager);
        await this.websocketServer.start();
      }

      this.emit('started');

      Logger.info('Stealth Browser V2 started successfully', {
        httpUrl: `http://${this.config.server.http.host}:${this.config.server.http.port}`,
        websocketUrl: this.config.server.websocket.enabled
          ? `ws://${this.config.server.http.host}:${this.config.server.websocket.port}`
          : 'disabled',
        health: `http://${this.config.server.http.host}:${this.config.server.http.port}/v2/health`
      });

    } catch (error) {
      Logger.error('Failed to start Stealth Browser V2', error);
      throw error;
    }
  }

  public async shutdown(): Promise<void> {
    if (this.isShuttingDown) {
      Logger.warn('Shutdown already in progress');
      return;
    }

    this.isShuttingDown = true;
    Logger.info('Shutting down Stealth Browser V2');

    try {
      // Emit shutdown event
      this.emit('shutdown');

      // Stop servers first
      if (this.websocketServer) {
        await this.websocketServer.shutdown();
      }

      if (this.httpServer) {
        await this.httpServer.shutdown();
      }

      // Shutdown components in reverse order
      if (this.sessionManager) {
        await this.sessionManager.shutdown();
      }

      if (this.pluginManager) {
        await this.pluginManager.shutdown();
      }

      if (this.displayManager) {
        await this.displayManager.shutdown();
      }

      if (this.attachManager) {
        await this.attachManager.shutdown();
      }

      if (this.browserManager) {
        await this.browserManager.shutdown();
      }

      // Cleanup configuration manager
      if (this.configManager) {
        this.configManager.destroy();
      }

      Logger.info('Stealth Browser V2 shutdown completed');

    } catch (error) {
      Logger.error('Error during shutdown', error);
      throw error;
    }
  }

  public getHealth(): any {
    return {
      status: 'healthy',
      version: '2.0.0',
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      timestamp: new Date().toISOString(),
      environment: this.configManager.getEnvironment(),
      components: {
        configManager: !!this.configManager,
        browserManager: this.browserManager ? this.browserManager.health() : null,
        sessionManager: this.sessionManager ? this.sessionManager.getSessionsHealth() : null,
        pluginManager: this.pluginManager ? {
          total: this.pluginManager.getAll().length,
          enabled: this.pluginManager.getAll().filter(p => this.pluginManager.isEnabled(p.name)).length
        } : null,
        httpServer: this.httpServer ? this.httpServer.getHealth() : null,
        websocketServer: this.websocketServer ? this.websocketServer.getHealth() : null
      }
    };
  }

  private async initializeBrowserManager(): Promise<void> {
    Logger.debug('Initializing Browser Manager');
    await this.browserManager.initialize();
    Logger.debug('Browser Manager initialized');
  }

  private async initializePluginManager(): Promise<void> {
    Logger.debug('Initializing Plugin Manager');
    await this.pluginManager.initialize();
    Logger.debug('Plugin Manager initialized');
  }

  private async initializeSessionManager(): Promise<void> {
    Logger.debug('Initializing Session Manager');
    await this.sessionManager.initialize();
    Logger.debug('Session Manager initialized');
  }

  private async initializeServers(): Promise<void> {
    Logger.debug('Initializing HTTP Server');
    await this.httpServer.initialize();
    Logger.debug('HTTP Server initialized');

    if (this.config.server.websocket.enabled) {
      Logger.debug('WebSocket server will be initialized when started');
    }
  }

  private setupEventHandlers(): void {
    // Browser Manager events
    this.browserManager.on('instanceCreated', (instanceId) => {
      Logger.info(`Browser instance created: ${instanceId}`);
      this.emit('browserInstanceCreated', instanceId);
    });

    this.browserManager.on('instanceDestroyed', (instanceId) => {
      Logger.info(`Browser instance destroyed: ${instanceId}`);
      this.emit('browserInstanceDestroyed', instanceId);
    });

    // Session Manager events
    this.sessionManager.on('sessionCreated', (session) => {
      Logger.info(`Session created: ${session.id}`);
      this.emit('sessionCreated', session);
    });

    this.sessionManager.on('sessionDestroyed', (session) => {
      Logger.info(`Session destroyed: ${session.id}`);
      this.emit('sessionDestroyed', session);
    });

    // Plugin Manager events
    this.pluginManager.on('pluginEnabled', (pluginName) => {
      Logger.info(`Plugin enabled: ${pluginName}`);
      this.emit('pluginEnabled', pluginName);
    });

    this.pluginManager.on('pluginDisabled', (pluginName) => {
      Logger.info(`Plugin disabled: ${pluginName}`);
      this.emit('pluginDisabled', pluginName);
    });

    // Configuration changes
    this.configManager.subscribe('config.changed', (config) => {
      Logger.info('Configuration changed');
      this.config = config;
      this.emit('configChanged', config);
    });
  }

  private setupProcessHandlers(): void {
    // Graceful shutdown on process signals
    const signals: NodeJS.Signals[] = ['SIGTERM', 'SIGINT', 'SIGUSR2'];

    for (const signal of signals) {
      process.on(signal, async () => {
        Logger.info(`Received ${signal}, initiating graceful shutdown`);
        try {
          await this.shutdown();
          process.exit(0);
        } catch (error) {
          Logger.error('Error during graceful shutdown', error);
          process.exit(1);
        }
      });
    }

    // Handle uncaught exceptions
    process.on('uncaughtException', (error) => {
      Logger.error('Uncaught exception', error);
      this.shutdown().finally(() => {
        process.exit(1);
      });
    });

    // Handle unhandled promise rejections
    process.on('unhandledRejection', (reason, promise) => {
      Logger.error('Unhandled rejection', reason, {
        promise: promise.toString()
      });
    });

    // Log memory usage periodically if in debug mode
    if (this.config.logging.level === 'debug') {
      setInterval(() => {
        const memUsage = process.memoryUsage();
        Logger.debug('Memory usage', {
          rss: `${Math.round(memUsage.rss / 1024 / 1024)}MB`,
          heapUsed: `${Math.round(memUsage.heapUsed / 1024 / 1024)}MB`,
          heapTotal: `${Math.round(memUsage.heapTotal / 1024 / 1024)}MB`,
          external: `${Math.round(memUsage.external / 1024 / 1024)}MB`
        });
      }, 30000); // Every 30 seconds
    }
  }
}

// Main execution function
async function main(): Promise<void> {
  const app = new StealthBrowserApp();

  try {
    // Start the application
    await app.start();

    // Setup graceful shutdown for HTTP server
    const httpServer = (app as any).httpServer.server;
    if (httpServer) {
      gracefulShutdown(httpServer, {
        signals: 'SIGINT SIGTERM',
        timeout: 30000,
        development: false,
        forceExit: true,
        onShutdown: async () => {
          Logger.info('HTTP server graceful shutdown initiated');
          await app.shutdown();
        }
      });
    }

  } catch (error) {
    Logger.error('Failed to start application', error);
    process.exit(1);
  }
}

// Export for testing and programmatic usage
export { StealthBrowserApp };

// Run if this is the main module
if (require.main === module) {
  main().catch((error) => {
    console.error('Fatal error starting Stealth Browser V2:', error);
    process.exit(1);
  });
}