import { EventEmitter } from 'events';
import path from 'path';
import fs from 'fs';
import { PluginInterface, PluginConfig, Session } from '@utils/types';
import { Logger } from '@utils/logger';
import ConfigManager from './config-manager';

interface PluginMetadata {
  plugin: PluginInterface;
  enabled: boolean;
  initialized: boolean;
  config: any;
  loadedAt: Date;
  hooks: {
    beforePageCreate: boolean;
    afterPageCreate: boolean;
    beforeNavigation: boolean;
    afterNavigation: boolean;
    onRequest: boolean;
    onResponse: boolean;
    cleanup: boolean;
  };
}

export class PluginManager extends EventEmitter {
  private plugins: Map<string, PluginMetadata> = new Map();
  private pluginConfig: PluginConfig;
  private pluginsDirectory: string;
  private isInitialized = false;

  constructor() {
    super();
    this.pluginConfig = ConfigManager.getInstance().get<PluginConfig>('plugins');
    this.pluginsDirectory = path.join(__dirname, '../plugins');

    // Listen for config changes
    ConfigManager.getInstance().subscribe('config.changed', (config) => {
      this.pluginConfig = config.plugins;
      this.handleConfigChange();
    });
  }

  public async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    Logger.info('Initializing Plugin Manager');

    // Auto-discover and load plugins
    await this.discoverPlugins();

    // Initialize enabled plugins
    await this.initializeEnabledPlugins();

    this.isInitialized = true;
    this.emit('initialized');
    Logger.info(`Plugin Manager initialized with ${this.plugins.size} plugins`);
  }

  public async register(plugin: PluginInterface, config?: any): Promise<void> {
    if (this.plugins.has(plugin.name)) {
      throw new Error(`Plugin already registered: ${plugin.name}`);
    }

    Logger.info(`Registering plugin: ${plugin.name}`, {
      version: plugin.version,
      dependencies: plugin.dependencies
    });

    // Check dependencies
    await this.checkDependencies(plugin);

    // Create metadata
    const metadata: PluginMetadata = {
      plugin,
      enabled: false,
      initialized: false,
      config: config || {},
      loadedAt: new Date(),
      hooks: {
        beforePageCreate: typeof plugin.beforePageCreate === 'function',
        afterPageCreate: typeof plugin.afterPageCreate === 'function',
        beforeNavigation: typeof plugin.beforeNavigation === 'function',
        afterNavigation: typeof plugin.afterNavigation === 'function',
        onRequest: typeof plugin.onRequest === 'function',
        onResponse: typeof plugin.onResponse === 'function',
        cleanup: typeof plugin.cleanup === 'function'
      }
    };

    this.plugins.set(plugin.name, metadata);
    this.emit('pluginRegistered', plugin.name);

    Logger.plugin(plugin.name, 'Plugin registered successfully');
  }

  public async unregister(name: string): Promise<void> {
    const metadata = this.plugins.get(name);
    if (!metadata) {
      throw new Error(`Plugin not found: ${name}`);
    }

    Logger.info(`Unregistering plugin: ${name}`);

    // Disable if enabled
    if (metadata.enabled) {
      await this.disable(name);
    }

    // Cleanup if initialized
    if (metadata.initialized && metadata.plugin.cleanup) {
      try {
        await metadata.plugin.cleanup();
      } catch (error) {
        Logger.error(`Error during plugin cleanup: ${name}`, error);
      }
    }

    this.plugins.delete(name);
    this.emit('pluginUnregistered', name);

    Logger.plugin(name, 'Plugin unregistered successfully');
  }

  public get(name: string): PluginInterface | undefined {
    const metadata = this.plugins.get(name);
    return metadata?.plugin;
  }

  public getAll(): PluginInterface[] {
    return Array.from(this.plugins.values()).map(metadata => metadata.plugin);
  }

  public isEnabled(name: string): boolean {
    const metadata = this.plugins.get(name);
    return metadata?.enabled || false;
  }

  public isPluginInitialized(name: string): boolean {
    const metadata = this.plugins.get(name);
    return metadata?.initialized || false;
  }

  public async enable(name: string): Promise<void> {
    const metadata = this.plugins.get(name);
    if (!metadata) {
      throw new Error(`Plugin not found: ${name}`);
    }

    if (metadata.enabled) {
      Logger.warn(`Plugin already enabled: ${name}`);
      return;
    }

    Logger.info(`Enabling plugin: ${name}`);

    // Initialize if not already done
    if (!metadata.initialized) {
      await this.initializePlugin(metadata);
    }

    metadata.enabled = true;
    this.emit('pluginEnabled', name);

    Logger.plugin(name, 'Plugin enabled successfully');
  }

  public async disable(name: string): Promise<void> {
    const metadata = this.plugins.get(name);
    if (!metadata) {
      throw new Error(`Plugin not found: ${name}`);
    }

    if (!metadata.enabled) {
      Logger.warn(`Plugin already disabled: ${name}`);
      return;
    }

    Logger.info(`Disabling plugin: ${name}`);

    metadata.enabled = false;
    this.emit('pluginDisabled', name);

    Logger.plugin(name, 'Plugin disabled successfully');
  }

  public async executeHook(
    hookName: keyof PluginMetadata['hooks'],
    session: Session,
    ...args: any[]
  ): Promise<void> {
    const enabledPlugins = Array.from(this.plugins.values())
      .filter(metadata => metadata.enabled && metadata.hooks[hookName]);

    const promises = enabledPlugins.map(async (metadata) => {
      try {
        const plugin = metadata.plugin;
        switch (hookName) {
          case 'beforePageCreate':
            if (plugin.beforePageCreate) {
              await plugin.beforePageCreate(args[0]);
            }
            break;
          case 'afterPageCreate':
            if (plugin.afterPageCreate) {
              await plugin.afterPageCreate(args[0]);
            }
            break;
          case 'beforeNavigation':
            if (plugin.beforeNavigation) {
              await plugin.beforeNavigation(args[0], args[1]);
            }
            break;
          case 'afterNavigation':
            if (plugin.afterNavigation) {
              await plugin.afterNavigation(args[0], args[1]);
            }
            break;
          case 'onRequest':
            if (plugin.onRequest) {
              await plugin.onRequest(args[0]);
            }
            break;
          case 'onResponse':
            if (plugin.onResponse) {
              await plugin.onResponse(args[0]);
            }
            break;
        }

        Logger.debug(`Executed hook ${hookName} for plugin: ${plugin.name}`, {
          sessionId: session.id
        });
      } catch (error) {
        Logger.error(`Error executing hook ${hookName} for plugin: ${metadata.plugin.name}`, error, {
          sessionId: session.id
        });
      }
    });

    await Promise.allSettled(promises);
  }

  public getPluginStatus(): Array<{
    name: string;
    version: string;
    enabled: boolean;
    initialized: boolean;
    loadedAt: Date;
    description: string;
    dependencies: string[];
    hooks: string[];
  }> {
    return Array.from(this.plugins.values()).map(metadata => ({
      name: metadata.plugin.name,
      version: metadata.plugin.version,
      enabled: metadata.enabled,
      initialized: metadata.initialized,
      loadedAt: metadata.loadedAt,
      description: metadata.plugin.description,
      dependencies: metadata.plugin.dependencies,
      hooks: Object.entries(metadata.hooks)
        .filter(([, hasHook]) => hasHook)
        .map(([hookName]) => hookName)
    }));
  }

  public updatePluginConfig(pluginName: string, config: any): void {
    const metadata = this.plugins.get(pluginName);
    if (!metadata) {
      throw new Error(`Plugin not found: ${pluginName}`);
    }

    metadata.config = { ...metadata.config, ...config };
    this.emit('pluginConfigUpdated', { pluginName, config: metadata.config });

    Logger.plugin(pluginName, 'Plugin configuration updated', { config: metadata.config });
  }

  private async discoverPlugins(): Promise<void> {
    if (!fs.existsSync(this.pluginsDirectory)) {
      Logger.warn(`Plugins directory not found: ${this.pluginsDirectory}`);
      return;
    }

    const categories = ['stealth', 'automation', 'monitoring'];

    for (const category of categories) {
      const categoryPath = path.join(this.pluginsDirectory, category);
      if (!fs.existsSync(categoryPath)) {
        continue;
      }

      const pluginFiles = fs.readdirSync(categoryPath)
        .filter(file => file.endsWith('.ts') || file.endsWith('.js'))
        .filter(file => !file.endsWith('.test.ts') && !file.endsWith('.test.js'));

      for (const file of pluginFiles) {
        try {
          const pluginPath = path.join(categoryPath, file);
          const pluginModule = require(pluginPath);
          const PluginClass = pluginModule.default || pluginModule;

          if (typeof PluginClass === 'function') {
            const plugin = new PluginClass();
            const pluginConfig = this.getPluginConfig(category, plugin.name);
            await this.register(plugin, pluginConfig);
          }
        } catch (error) {
          Logger.error(`Failed to load plugin: ${file}`, error);
        }
      }
    }
  }

  private async initializeEnabledPlugins(): Promise<void> {
    const enabledPluginNames = this.getEnabledPluginNames();

    for (const pluginName of enabledPluginNames) {
      const metadata = this.plugins.get(pluginName);
      if (metadata && !metadata.initialized) {
        try {
          await this.enable(pluginName);
        } catch (error) {
          Logger.error(`Failed to enable plugin: ${pluginName}`, error);
        }
      }
    }
  }

  private async initializePlugin(metadata: PluginMetadata): Promise<void> {
    if (metadata.initialized) {
      return;
    }

    Logger.debug(`Initializing plugin: ${metadata.plugin.name}`);

    try {
      await metadata.plugin.initialize(metadata.config);
      metadata.initialized = true;
      this.emit('pluginInitialized', metadata.plugin.name);

      Logger.plugin(metadata.plugin.name, 'Plugin initialized successfully');
    } catch (error) {
      Logger.error(`Failed to initialize plugin: ${metadata.plugin.name}`, error);
      throw error;
    }
  }

  private async checkDependencies(plugin: PluginInterface): Promise<void> {
    const missingDependencies = [];

    for (const dependency of plugin.dependencies) {
      if (!this.plugins.has(dependency)) {
        missingDependencies.push(dependency);
      }
    }

    if (missingDependencies.length > 0) {
      throw new Error(
        `Plugin ${plugin.name} has missing dependencies: ${missingDependencies.join(', ')}`
      );
    }
  }

  private getPluginConfig(category: string, pluginName: string): any {
    const categoryConfig = (this.pluginConfig as any)[category];
    if (!categoryConfig) {
      return {};
    }

    return categoryConfig[pluginName] || categoryConfig;
  }

  private getEnabledPluginNames(): string[] {
    const enabled: string[] = [];

    // Check each plugin category
    Object.entries(this.pluginConfig).forEach(([category, config]) => {
      if (typeof config === 'object' && config !== null && 'enabled' in config) {
        if ((config as any).enabled) {
          // Find plugins in this category
          for (const [pluginName, metadata] of this.plugins) {
            if (metadata.plugin.name.startsWith(category)) {
              enabled.push(pluginName);
            }
          }
        }
      }
    });

    return enabled;
  }

  private handleConfigChange(): void {
    Logger.debug('Plugin configuration changed, updating plugin states');

    // Re-evaluate enabled state for all plugins
    const newEnabledNames = this.getEnabledPluginNames();

    for (const [pluginName, metadata] of this.plugins) {
      const shouldBeEnabled = newEnabledNames.includes(pluginName);

      if (shouldBeEnabled && !metadata.enabled) {
        this.enable(pluginName).catch(error => {
          Logger.error(`Failed to auto-enable plugin ${pluginName}`, error);
        });
      } else if (!shouldBeEnabled && metadata.enabled) {
        this.disable(pluginName).catch(error => {
          Logger.error(`Failed to auto-disable plugin ${pluginName}`, error);
        });
      }
    }
  }

  public async shutdown(): Promise<void> {
    Logger.info('Shutting down Plugin Manager');

    // Cleanup all plugins
    const cleanupPromises = Array.from(this.plugins.values()).map(async (metadata) => {
      try {
        if (metadata.initialized && metadata.plugin.cleanup) {
          await metadata.plugin.cleanup();
        }
      } catch (error) {
        Logger.error(`Error during plugin cleanup: ${metadata.plugin.name}`, error);
      }
    });

    await Promise.allSettled(cleanupPromises);
    this.plugins.clear();
    this.emit('shutdown');

    Logger.info('Plugin Manager shutdown complete');
  }
}

export default PluginManager;