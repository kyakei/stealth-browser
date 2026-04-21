import fs from 'fs';
import path from 'path';
import Joi from 'joi';
import { AppConfig, DeepPartial } from '@utils/types';
import { Logger } from '@utils/logger';

export class ConfigManager {
  private static instance: ConfigManager;
  private config: AppConfig;
  private configPath: string;
  private watchers: Map<string, fs.FSWatcher> = new Map();
  private subscribers: Map<string, ((config: AppConfig) => void)[]> = new Map();

  private constructor() {
    this.configPath = process.env.CONFIG_PATH || path.join(__dirname, '../../config');
    this.config = this.loadConfig();
    this.validateConfig();
    this.setupWatchers();
  }

  public static getInstance(): ConfigManager {
    if (!ConfigManager.instance) {
      ConfigManager.instance = new ConfigManager();
    }
    return ConfigManager.instance;
  }

  public getConfig(): AppConfig {
    return this.config;
  }

  public get<T = any>(key: string): T {
    const keys = key.split('.');
    let value: any = this.config;

    for (const k of keys) {
      if (value && typeof value === 'object' && k in value) {
        value = value[k];
      } else {
        return undefined as T;
      }
    }

    return value as T;
  }

  public set(key: string, value: any): void {
    const keys = key.split('.');
    let target: any = this.config;

    for (let i = 0; i < keys.length - 1; i++) {
      const k = keys[i];
      if (!k) continue; // Skip if key is undefined
      if (!(k in target) || typeof target[k] !== 'object') {
        target[k] = {};
      }
      target = target[k];
    }

    const lastKey = keys[keys.length - 1];
    if (lastKey) {
      target[lastKey] = value;
    }

    this.validateConfig();
    this.notifySubscribers('config.changed');
    Logger.info('Configuration updated', { key, value });
  }

  public update(partialConfig: DeepPartial<AppConfig>): void {
    this.config = this.mergeDeep(this.config, partialConfig);
    this.validateConfig();
    this.notifySubscribers('config.updated');
    Logger.info('Configuration bulk updated');
  }

  public reload(): void {
    try {
      const newConfig = this.loadConfig();
      this.validateConfig();
      const oldConfig = this.config;
      this.config = newConfig;

      this.notifySubscribers('config.reloaded');
      Logger.info('Configuration reloaded', {
        oldConfigHash: this.hashConfig(oldConfig),
        newConfigHash: this.hashConfig(newConfig)
      });
    } catch (error) {
      Logger.error('Failed to reload configuration', error);
      throw error;
    }
  }

  public subscribe(event: string, callback: (config: AppConfig) => void): void {
    if (!this.subscribers.has(event)) {
      this.subscribers.set(event, []);
    }
    this.subscribers.get(event)!.push(callback);
  }

  public unsubscribe(event: string, callback: (config: AppConfig) => void): void {
    const subscribers = this.subscribers.get(event);
    if (subscribers) {
      const index = subscribers.indexOf(callback);
      if (index > -1) {
        subscribers.splice(index, 1);
      }
    }
  }

  public getEnvironment(): string {
    return process.env.NODE_ENV || 'development';
  }

  public isDevelopment(): boolean {
    return this.getEnvironment() === 'development';
  }

  public isProduction(): boolean {
    return this.getEnvironment() === 'production';
  }

  public isTest(): boolean {
    return this.getEnvironment() === 'test';
  }

  private loadConfig(): AppConfig {
    const env = this.getEnvironment();
    const defaultConfigPath = path.join(this.configPath, 'default.json');
    const envConfigPath = path.join(this.configPath, `${env}.json`);

    // Load default configuration
    if (!fs.existsSync(defaultConfigPath)) {
      throw new Error(`Default configuration file not found: ${defaultConfigPath}`);
    }

    let config: AppConfig;
    try {
      const defaultConfig = JSON.parse(fs.readFileSync(defaultConfigPath, 'utf8'));
      config = defaultConfig;
    } catch (error) {
      throw new Error(`Failed to parse default configuration: ${error}`);
    }

    // Override with environment-specific configuration
    if (fs.existsSync(envConfigPath)) {
      try {
        const envConfig = JSON.parse(fs.readFileSync(envConfigPath, 'utf8'));
        config = this.mergeDeep(config, envConfig);
      } catch (error) {
        Logger.warn(`Failed to parse environment configuration: ${error}`);
      }
    }

    // Override with environment variables
    this.applyEnvironmentVariables(config);

    return config;
  }

  private applyEnvironmentVariables(config: AppConfig): void {
    const envMappings: Record<string, string> = {
      'HTTP_PORT': 'server.http.port',
      'WS_PORT': 'server.websocket.port',
      'LOG_LEVEL': 'logging.level',
      'BROWSER_HEADLESS': 'browser.headless',
      'BROWSER_EXECUTABLE': 'browser.executablePath',
      'MAX_SESSIONS': 'sessions.maxConcurrent',
      'AUTH_ENABLED': 'server.auth.enabled',
      'JWT_SECRET': 'server.auth.jwt.secret',
    };

    for (const [envVar, configPath] of Object.entries(envMappings)) {
      const value = process.env[envVar];
      if (value !== undefined) {
        this.setByPath(config, configPath, this.parseEnvironmentValue(value));
      }
    }
  }

  private parseEnvironmentValue(value: string): any {
    // Try to parse as boolean
    if (value.toLowerCase() === 'true') return true;
    if (value.toLowerCase() === 'false') return false;

    // Try to parse as number
    const numValue = Number(value);
    if (!isNaN(numValue) && isFinite(numValue)) return numValue;

    // Return as string
    return value;
  }

  private setByPath(obj: any, path: string, value: any): void {
    const keys = path.split('.');
    let current = obj;

    for (let i = 0; i < keys.length - 1; i++) {
      const key = keys[i];
      if (!key) continue; // Skip if key is undefined
      if (!(key in current) || typeof current[key] !== 'object') {
        current[key] = {};
      }
      current = current[key];
    }

    const lastKey = keys[keys.length - 1];
    if (lastKey) {
      current[lastKey] = value;
    }
  }

  private validateConfig(): void {
    const schema = this.getConfigSchema();
    const { error } = schema.validate(this.config);

    if (error) {
      throw new Error(`Configuration validation failed: ${error.message}`);
    }
  }

  private getConfigSchema(): Joi.ObjectSchema {
    return Joi.object({
      server: Joi.object({
        http: Joi.object({
          port: Joi.number().port().required(),
          host: Joi.string().required(),
          cors: Joi.object({
            enabled: Joi.boolean().required(),
            origins: Joi.array().items(Joi.string()).required()
          }).required()
        }).required(),
        websocket: Joi.object({
          enabled: Joi.boolean().required(),
          port: Joi.number().port().required()
        }).required(),
        auth: Joi.object({
          enabled: Joi.boolean().required(),
          apiKey: Joi.string().allow(null),
          jwt: Joi.object({
            secret: Joi.string().min(32).required(),
            expiresIn: Joi.string().required()
          }).required()
        }).required(),
        rateLimit: Joi.object({
          windowMs: Joi.number().positive().required(),
          max: Joi.number().positive().required(),
          message: Joi.string().required()
        }).required()
      }).required(),
      browser: Joi.object({
        engine: Joi.string().valid('chromium', 'firefox', 'webkit').required(),
        headless: Joi.boolean().required(),
        executablePath: Joi.string().required(),
        userDataDir: Joi.string().required(),
        args: Joi.array().items(Joi.string()).required(),
        pool: Joi.object({
          min: Joi.number().min(1).required(),
          max: Joi.number().min(1).required(),
          idleTimeout: Joi.number().positive().required(),
          acquireTimeout: Joi.number().positive().required()
        }).required()
      }).required(),
      sessions: Joi.object({
        maxConcurrent: Joi.number().positive().required(),
        defaultTimeout: Joi.number().positive().required(),
        persistenceEnabled: Joi.boolean().required(),
        cleanupInterval: Joi.number().positive().required(),
        stateDirectory: Joi.string().required(),
        maxAge: Joi.number().positive().required()
      }).required(),
      plugins: Joi.object({
        stealth: Joi.object({
          enabled: Joi.boolean().required(),
          level: Joi.string().valid('low', 'medium', 'high').required(),
          fingerprintRandomization: Joi.boolean().required(),
          webglVendorSpoofing: Joi.boolean().required(),
          userAgentRotation: Joi.boolean().required()
        }).required(),
        automation: Joi.object({
          enabled: Joi.boolean().required(),
          humanBehavior: Joi.boolean().required(),
          typingDelay: Joi.object({
            min: Joi.number().min(0).required(),
            max: Joi.number().min(0).required()
          }).required(),
          clickDelay: Joi.object({
            min: Joi.number().min(0).required(),
            max: Joi.number().min(0).required()
          }).required()
        }).required(),
        monitoring: Joi.object({
          enabled: Joi.boolean().required(),
          metricsInterval: Joi.number().positive().required(),
          performanceTracking: Joi.boolean().required(),
          networkMonitoring: Joi.boolean().required()
        }).required(),
        captcha: Joi.object({
          enabled: Joi.boolean().required(),
          solver: Joi.string().required(),
          timeout: Joi.number().positive().required(),
          retries: Joi.number().min(0).required()
        }).required()
      }).required(),
      logging: Joi.object({
        level: Joi.string().valid('error', 'warn', 'info', 'debug').required(),
        console: Joi.boolean().required(),
        file: Joi.object({
          enabled: Joi.boolean().required(),
          path: Joi.string().required(),
          maxFiles: Joi.number().positive().required(),
          maxSize: Joi.string().required()
        }).required(),
        format: Joi.string().required()
      }).required(),
      security: Joi.object().required()
    });
  }

  private setupWatchers(): void {
    if (this.isDevelopment()) {
      const configFiles = ['default.json', 'development.json'];

      for (const file of configFiles) {
        const filePath = path.join(this.configPath, file);
        if (fs.existsSync(filePath)) {
          const watcher = fs.watch(filePath, (eventType) => {
            if (eventType === 'change') {
              Logger.info(`Configuration file changed: ${file}`);
              setTimeout(() => this.reload(), 1000); // Debounce
            }
          });

          this.watchers.set(file, watcher);
        }
      }
    }
  }

  private mergeDeep(target: any, source: any): any {
    const output = { ...target };

    if (this.isObject(target) && this.isObject(source)) {
      Object.keys(source).forEach(key => {
        if (this.isObject(source[key])) {
          if (!(key in target)) {
            Object.assign(output, { [key]: source[key] });
          } else {
            output[key] = this.mergeDeep(target[key], source[key]);
          }
        } else {
          Object.assign(output, { [key]: source[key] });
        }
      });
    }

    return output;
  }

  private isObject(item: any): boolean {
    return item && typeof item === 'object' && !Array.isArray(item);
  }

  private notifySubscribers(event: string): void {
    const subscribers = this.subscribers.get(event);
    if (subscribers) {
      for (const callback of subscribers) {
        try {
          callback(this.config);
        } catch (error) {
          Logger.error('Error in config subscriber', error);
        }
      }
    }
  }

  private hashConfig(config: AppConfig): string {
    const crypto = require('crypto');
    return crypto.createHash('md5').update(JSON.stringify(config)).digest('hex');
  }

  public destroy(): void {
    // Close file watchers
    for (const [file, watcher] of this.watchers) {
      watcher.close();
      Logger.debug(`Closed config watcher for: ${file}`);
    }

    this.watchers.clear();
    this.subscribers.clear();
  }
}

export default ConfigManager;