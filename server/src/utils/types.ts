import { BrowserContext, Page, Browser } from 'playwright';
import { Server } from 'http';
import { WebSocketServer } from 'ws';

// Configuration Types
export interface ServerConfig {
  http: {
    port: number;
    host: string;
    cors: {
      enabled: boolean;
      origins: string[];
    };
  };
  websocket: {
    enabled: boolean;
    port: number;
  };
  auth: {
    enabled: boolean;
    apiKey: string | null;
    jwt: {
      secret: string;
      expiresIn: string;
    };
  };
  rateLimit: {
    windowMs: number;
    max: number;
    message: string;
  };
  security?: {
    helmet?: any;
    compression?: boolean;
  };
}

export interface BrowserConfig {
  engine: 'chromium' | 'firefox' | 'webkit';
  headless: boolean;
  executablePath: string;
  userDataDir: string;
  args: string[];
  pool: {
    min: number;
    max: number;
    idleTimeout: number;
    acquireTimeout: number;
  };
}

export interface SessionConfig {
  maxConcurrent: number;
  defaultTimeout: number;
  persistenceEnabled: boolean;
  cleanupInterval: number;
  stateDirectory: string;
  maxAge: number;
}

export interface PluginConfig {
  stealth: {
    enabled: boolean;
    level: 'low' | 'medium' | 'high';
    fingerprintRandomization: boolean;
    webglVendorSpoofing: boolean;
    userAgentRotation: boolean;
  };
  automation: {
    enabled: boolean;
    humanBehavior: boolean;
    typingDelay: { min: number; max: number };
    clickDelay: { min: number; max: number };
  };
  monitoring: {
    enabled: boolean;
    metricsInterval: number;
    performanceTracking: boolean;
    networkMonitoring: boolean;
  };
  captcha: {
    enabled: boolean;
    solver: 'auto' | 'manual' | string;
    timeout: number;
    retries: number;
  };
}

export interface LoggingConfig {
  level: 'error' | 'warn' | 'info' | 'debug';
  console: boolean;
  file: {
    enabled: boolean;
    path: string;
    maxFiles: number;
    maxSize: string;
  };
  format: string;
}

export interface AppConfig {
  server: ServerConfig;
  browser: BrowserConfig;
  sessions: SessionConfig;
  plugins: PluginConfig;
  logging: LoggingConfig;
  security: any;
}

// Session Types
export interface SessionMetadata {
  id: string;
  createdAt: Date;
  lastActivity: Date;
  userAgent: string;
  viewport: { width: number; height: number };
  plugins: string[];
  persistent: boolean;
  tags: string[];
}

export interface SessionState {
  cookies: any[];
  localStorage: Record<string, any>;
  sessionStorage: Record<string, any>;
  url: string;
  metadata: SessionMetadata;
}

export interface SessionOptions {
  userAgent?: string;
  viewport?: { width: number; height: number };
  locale?: string;
  timezone?: string;
  geolocation?: { latitude: number; longitude: number };
  permissions?: string[];
  plugins?: string[];
  persistent?: boolean;
  tags?: string[];
  storageState?: string;
}

export interface Session {
  id: string;
  context: BrowserContext;
  page: Page;
  metadata: SessionMetadata;
  plugins: Map<string, any>;
  metrics: SessionMetrics;
  isActive: boolean;
  createdAt: Date;
  lastActivity: Date;
  /**
   * Auth-like request headers captured from XHR/fetch traffic, keyed by
   * `${host}|${headerName.toLowerCase()}`. Last-value-wins per key.
   * Populated by the built-in auth-header sniffer in session-manager.
   */
  capturedHeaders: Map<string, CapturedHeader>;
  /**
   * Free-form key-value store for user-JS plugins (Phase D). Scripts can
   * call `ctx.save('key', value)` and the value is retrievable via
   * GET /v2/sessions/:id/plugin-store.
   */
  pluginStore: Map<string, any>;
}

export interface CapturedHeader {
  host: string;
  header: string;  // lowercase header name
  value: string;
  url: string;
  method: string;
  capturedAt: Date;
}

export interface NetworkLogEntry {
  t: string;              // ISO timestamp
  id: string;             // request UUID
  sessionId: string;
  method: string;
  url: string;
  status?: number;
  reqHeaders: Record<string, string>;
  reqBody?: string | null;
  reqBodyBytes?: number;
  respHeaders?: Record<string, string>;
  respStatus?: number;
  respCT?: string;
  respBodyBytes?: number;
  respBody?: string | null;
  timing?: { duration_ms: number; ttfb_ms?: number };
  failed?: boolean;
  failureText?: string;
}

export interface CurlParsed {
  url: string;
  method: string;
  headers: Record<string, string>;
  cookies: Record<string, string>;
  body: string | null;
}

// Plugin Types
export interface PluginInterface {
  name: string;
  version: string;
  description: string;
  dependencies: string[];
  config: any;

  initialize(config: any): Promise<void>;
  beforePageCreate?(page: Page): Promise<void>;
  afterPageCreate?(page: Page): Promise<void>;
  beforeNavigation?(url: string, page: Page): Promise<void>;
  afterNavigation?(url: string, page: Page): Promise<void>;
  onRequest?(request: any): Promise<void>;
  onResponse?(response: any): Promise<void>;
  cleanup?(): Promise<void>;
}

export interface PluginManager {
  register(plugin: PluginInterface): void;
  unregister(name: string): void;
  get(name: string): PluginInterface | undefined;
  getAll(): PluginInterface[];
  isEnabled(name: string): boolean;
  enable(name: string): void;
  disable(name: string): void;
}

// Browser Management Types
export interface BrowserInstance {
  id: string;
  browser: Browser;
  sessions: Map<string, Session>;
  createdAt: Date;
  lastUsed: Date;
  isHealthy: boolean;
}

export interface BrowserPool {
  instances: Map<string, BrowserInstance>;
  acquire(): Promise<BrowserInstance>;
  release(id: string): Promise<void>;
  destroy(id: string): Promise<void>;
  health(): { total: number; active: number; healthy: number };
}

// API Types
export interface ApiRequest {
  sessionId?: string;
  url?: string;
  selector?: string;
  value?: string;
  text?: string;
  script?: string;
  timeout?: number;
  waitFor?: 'load' | 'domcontentloaded' | 'networkidle';
  options?: Record<string, any>;
}

export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: any;
  };
  sessionId?: string;
  timestamp: Date;
  duration: number;
}

// Automation Types
export interface FormField {
  selector: string;
  type: 'text' | 'email' | 'password' | 'number' | 'tel' | 'url' | 'search';
  value: string;
  required?: boolean;
}

export interface FormData {
  fields: FormField[];
  submitSelector?: string;
  waitAfterSubmit?: number;
  waitForSelector?: string;
}

export interface NavigationOptions {
  waitUntil?: 'load' | 'domcontentloaded' | 'networkidle';
  timeout?: number;
  referer?: string;
  extraHeaders?: Record<string, string>;
}

export interface ClickOptions {
  button?: 'left' | 'right' | 'middle';
  clickCount?: number;
  delay?: number;
  position?: { x: number; y: number };
  modifiers?: string[];
  force?: boolean;
}

export interface TypeOptions {
  delay?: number;
  humanLike?: boolean;
  clear?: boolean;
}

// Metrics Types
export interface SessionMetrics {
  requests: number;
  responses: number;
  errors: number;
  averageResponseTime: number;
  networkData: {
    bytesReceived: number;
    bytesSent: number;
  };
  pageMetrics: {
    loadTime: number;
    domContentLoaded: number;
    firstContentfulPaint?: number;
  };
  interactions: {
    clicks: number;
    keystrokes: number;
    scrolls: number;
    navigations: number;
  };
}

export interface SystemMetrics {
  uptime: number;
  memory: {
    used: number;
    total: number;
    percentage: number;
  };
  cpu: {
    usage: number;
  };
  sessions: {
    active: number;
    total: number;
  };
  browser: {
    instances: number;
    memory: number;
  };
}

// Event Types
export interface SessionEvent {
  type: 'created' | 'destroyed' | 'navigation' | 'interaction' | 'error';
  sessionId: string;
  timestamp: Date;
  data: any;
}

export interface SystemEvent {
  type: 'startup' | 'shutdown' | 'error' | 'warning' | 'info';
  timestamp: Date;
  message: string;
  data?: any;
}

// Error Types
export class BrowserError extends Error {
  constructor(
    message: string,
    public code: string,
    public sessionId?: string,
    public details?: any
  ) {
    super(message);
    this.name = 'BrowserError';
  }
}

export class SessionError extends Error {
  constructor(
    message: string,
    public sessionId: string,
    public code: string,
    public details?: any
  ) {
    super(message);
    this.name = 'SessionError';
  }
}

export class PluginError extends Error {
  constructor(
    message: string,
    public pluginName: string,
    public code: string,
    public details?: any
  ) {
    super(message);
    this.name = 'PluginError';
  }
}

// Utility Types
export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};

export type RequireAtLeastOne<T, Keys extends keyof T = keyof T> = Pick<T, Exclude<keyof T, Keys>> &
  {
    [K in Keys]-?: Required<Pick<T, K>> & Partial<Pick<T, Exclude<Keys, K>>>;
  }[Keys];

export type EventCallback<T = any> = (data: T) => void | Promise<void>;

export interface EventEmitter {
  on<T = any>(event: string, callback: EventCallback<T>): void;
  off<T = any>(event: string, callback: EventCallback<T>): void;
  emit<T = any>(event: string, data?: T): void;
}