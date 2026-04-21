import winston from 'winston';
import path from 'path';
import fs from 'fs';
import { LoggingConfig } from './types';

export class Logger {
  private static instance: winston.Logger;
  private static config: LoggingConfig;

  public static initialize(config: LoggingConfig): void {
    Logger.config = config;

    // Ensure log directory exists
    if (config.file.enabled) {
      const logDir = path.dirname(config.file.path);
      if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
      }
    }

    // Configure transports
    const transports: winston.transport[] = [];

    // Console transport
    if (config.console) {
      transports.push(
        new winston.transports.Console({
          format: winston.format.combine(
            winston.format.colorize(),
            winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
            winston.format.printf(({ timestamp, level, message, ...meta }) => {
              const metaStr = Object.keys(meta).length ? JSON.stringify(meta, null, 2) : '';
              return `${timestamp} [${level}]: ${message} ${metaStr}`;
            })
          ),
        })
      );
    }

    // File transport
    if (config.file.enabled) {
      transports.push(
        new winston.transports.File({
          filename: config.file.path,
          maxFiles: config.file.maxFiles,
          maxsize: Logger.parseSize(config.file.maxSize),
          format: winston.format.combine(
            winston.format.timestamp(),
            winston.format.errors({ stack: true }),
            winston.format.json()
          ),
        })
      );
    }

    // Create logger instance
    Logger.instance = winston.createLogger({
      level: config.level,
      transports,
      exitOnError: false,
      handleExceptions: true,
      handleRejections: true,
    });

    Logger.instance.info('Logger initialized', { config: Logger.sanitizeConfig(config) });
  }

  public static getInstance(): winston.Logger {
    if (!Logger.instance) {
      throw new Error('Logger not initialized. Call Logger.initialize() first.');
    }
    return Logger.instance;
  }

  public static info(message: string, meta?: any): void {
    Logger.getInstance().info(message, meta);
  }

  public static warn(message: string, meta?: any): void {
    Logger.getInstance().warn(message, meta);
  }

  public static error(message: string, error?: Error | any, meta?: any): void {
    const errorMeta = error instanceof Error
      ? {
          error: {
            message: error.message,
            stack: error.stack,
            name: error.name,
          },
          ...meta
        }
      : { error, ...meta };

    Logger.getInstance().error(message, errorMeta);
  }

  public static debug(message: string, meta?: any): void {
    Logger.getInstance().debug(message, meta);
  }

  public static session(sessionId: string, message: string, meta?: any): void {
    Logger.getInstance().info(message, { sessionId, ...meta });
  }

  public static plugin(pluginName: string, message: string, meta?: any): void {
    Logger.getInstance().info(message, { plugin: pluginName, ...meta });
  }

  public static api(method: string, url: string, statusCode: number, duration: number, meta?: any): void {
    Logger.getInstance().info('API Request', {
      type: 'api',
      method,
      url,
      statusCode,
      duration: `${duration}ms`,
      ...meta
    });
  }

  public static performance(event: string, duration: number, meta?: any): void {
    Logger.getInstance().info('Performance', {
      type: 'performance',
      event,
      duration: `${duration}ms`,
      ...meta
    });
  }

  public static security(message: string, meta?: any): void {
    Logger.getInstance().warn(message, { type: 'security', ...meta });
  }

  public static browser(browserId: string, message: string, meta?: any): void {
    Logger.getInstance().info(message, { type: 'browser', browserId, ...meta });
  }

  public static metrics(metrics: any): void {
    Logger.getInstance().info('System Metrics', { type: 'metrics', ...metrics });
  }

  public static setLevel(level: string): void {
    if (Logger.instance) {
      Logger.instance.level = level;
      Logger.info(`Log level changed to: ${level}`);
    }
  }

  public static getLevel(): string {
    return Logger.instance ? Logger.instance.level : 'info';
  }

  public static createChildLogger(defaultMeta: any): winston.Logger {
    return Logger.getInstance().child(defaultMeta);
  }

  private static parseSize(size: string): number {
    const units: Record<string, number> = {
      b: 1,
      k: 1024,
      kb: 1024,
      m: 1024 * 1024,
      mb: 1024 * 1024,
      g: 1024 * 1024 * 1024,
      gb: 1024 * 1024 * 1024,
    };

    const match = size.toLowerCase().match(/^(\d+)(b|k|kb|m|mb|g|gb)?$/);
    if (!match) {
      throw new Error(`Invalid size format: ${size}`);
    }

    const [, num, unit = 'b'] = match;
    if (!num) {
      throw new Error(`Invalid size format: ${size}`);
    }
    return parseInt(num, 10) * (units[unit] || 1);
  }

  private static sanitizeConfig(config: LoggingConfig): any {
    return {
      level: config.level,
      console: config.console,
      file: {
        enabled: config.file.enabled,
        path: config.file.path,
        maxFiles: config.file.maxFiles,
        maxSize: config.file.maxSize,
      },
      format: config.format,
    };
  }
}

// Export convenience functions
export const logger = {
  info: Logger.info,
  warn: Logger.warn,
  error: Logger.error,
  debug: Logger.debug,
  session: Logger.session,
  plugin: Logger.plugin,
  api: Logger.api,
  performance: Logger.performance,
  security: Logger.security,
  browser: Logger.browser,
  metrics: Logger.metrics,
};

export default Logger;