import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { Page, Request, Response } from 'playwright';
import { NetworkLogEntry } from '@utils/types';
import { Logger } from '@utils/logger';

export interface NetworkLoggerConfig {
  /** Where per-session JSONL files live. Directory is created on first write. */
  directory: string;
  /** Max in-memory entries retained for fast filter/query. Oldest dropped. */
  memoryBufferSize: number;
  /** Body capture limits. Anything larger is metadata-only (size recorded, body:null). */
  captureBodies: {
    /** Capture request body if non-binary and <= this many bytes. */
    reqMaxBytes: number;
    /** Capture response body if non-binary and <= this many bytes. */
    respMaxBytes: number;
  };
  /** Resource types we skip entirely — noisy and never useful for bug hunting. */
  skipResourceTypes: ReadonlyArray<string>;
}

const DEFAULT_CONFIG: NetworkLoggerConfig = {
  directory: path.join(process.cwd(), 'logs', 'network'),
  memoryBufferSize: 2000,
  captureBodies: {
    reqMaxBytes: 100 * 1024,
    respMaxBytes: 500 * 1024
  },
  skipResourceTypes: ['image', 'media', 'font']
};

/**
 * Types we consider "body-safe" to persist verbatim. Everything else is metadata-only.
 */
const TEXT_CONTENT_TYPES = [
  'json',
  'xml',
  'javascript',
  'text/',
  'application/x-www-form-urlencoded',
  'application/graphql',
  'application/x-ndjson'
];

function isTextualContentType(ct: string | null | undefined): boolean {
  if (!ct) return false;
  const lower = ct.toLowerCase();
  return TEXT_CONTENT_TYPES.some(t => lower.includes(t));
}

/**
 * Per-session network capture. Attach to a Playwright Page and it will:
 *   - record one JSONL entry per completed or failed request to `logs/network/sess-{id}.jsonl`
 *   - keep the last N entries in memory for fast /network query
 *   - cap body capture to prevent unbounded memory use
 *
 * All methods are best-effort; logging errors never propagate out.
 */
export class NetworkLogger {
  public readonly sessionId: string;
  private config: NetworkLoggerConfig;
  private buffer: NetworkLogEntry[] = [];
  private byId: Map<string, NetworkLogEntry> = new Map();
  private inflight: Map<string, Partial<NetworkLogEntry> & { startedAt: number }> = new Map();
  private writeStream: fs.WriteStream | null = null;
  private logFilePath: string;
  private requestTag: WeakMap<Request, string> = new WeakMap();
  private closed = false;

  constructor(sessionId: string, config: Partial<NetworkLoggerConfig> = {}) {
    this.sessionId = sessionId;
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
      captureBodies: { ...DEFAULT_CONFIG.captureBodies, ...(config.captureBodies || {}) }
    };
    this.logFilePath = path.join(this.config.directory, `sess-${sessionId}.jsonl`);
  }

  /**
   * Lazily create the writable stream on first write. Avoids creating
   * empty log files for sessions that never issue any traffic.
   */
  private ensureStream(): fs.WriteStream | null {
    if (this.writeStream) return this.writeStream;
    if (this.closed) return null;
    try {
      fs.mkdirSync(this.config.directory, { recursive: true });
      this.writeStream = fs.createWriteStream(this.logFilePath, { flags: 'a' });
      this.writeStream.on('error', err => {
        Logger.error(`[network-logger ${this.sessionId}] write error`, err);
      });
      return this.writeStream;
    } catch (err) {
      Logger.error(`[network-logger ${this.sessionId}] failed to open log file`, err);
      return null;
    }
  }

  /**
   * Attach this logger to a Playwright page. Wires request/response/failure events.
   */
  public attach(page: Page): void {
    page.on('request', req => this.onRequest(req));
    page.on('response', resp => { void this.onResponse(resp); });
    page.on('requestfailed', req => this.onRequestFailed(req));
  }

  private onRequest(req: Request): void {
    try {
      if (this.config.skipResourceTypes.includes(req.resourceType())) return;
      const id = uuidv4();
      this.requestTag.set(req, id);
      const headers = req.headers();
      let reqBody: string | null = null;
      let reqBodyBytes = 0;
      try {
        const pd = req.postData();
        if (pd !== null) {
          reqBodyBytes = Buffer.byteLength(pd, 'utf8');
          const ct = (headers['content-type'] || headers['Content-Type'] || '').toString();
          if (isTextualContentType(ct) && reqBodyBytes <= this.config.captureBodies.reqMaxBytes) {
            reqBody = pd;
          }
        }
      } catch {
        // postData unavailable — continue with metadata only
      }
      this.inflight.set(id, {
        t: new Date().toISOString(),
        id,
        sessionId: this.sessionId,
        method: req.method(),
        url: req.url(),
        reqHeaders: headers,
        reqBody,
        reqBodyBytes,
        startedAt: Date.now()
      });
    } catch (err) {
      Logger.error(`[network-logger ${this.sessionId}] onRequest error`, err);
    }
  }

  private async onResponse(resp: Response): Promise<void> {
    const req = resp.request();
    try {
      if (this.config.skipResourceTypes.includes(req.resourceType())) return;
      const id = this.requestTag.get(req);
      if (!id) return;
      const partial = this.inflight.get(id);
      if (!partial) return;
      this.inflight.delete(id);

      const respHeaders = resp.headers();
      const respCT = respHeaders['content-type'] || '';
      let respBody: string | null = null;
      let respBodyBytes = 0;
      try {
        const buf = await resp.body();
        respBodyBytes = buf.length;
        if (isTextualContentType(respCT) && respBodyBytes <= this.config.captureBodies.respMaxBytes) {
          respBody = buf.toString('utf8');
        }
      } catch {
        // Some responses (no content, redirects, CORS preflights) don't expose body.
      }

      const entry: NetworkLogEntry = {
        t: partial.t || new Date().toISOString(),
        id,
        sessionId: this.sessionId,
        method: partial.method || req.method(),
        url: partial.url || req.url(),
        status: resp.status(),
        reqHeaders: partial.reqHeaders || {},
        reqBody: partial.reqBody ?? null,
        reqBodyBytes: partial.reqBodyBytes ?? 0,
        respHeaders,
        respStatus: resp.status(),
        respCT,
        respBody,
        respBodyBytes,
        timing: { duration_ms: Date.now() - (partial.startedAt || Date.now()) }
      };

      this.record(entry);
    } catch (err) {
      Logger.error(`[network-logger ${this.sessionId}] onResponse error`, err);
    }
  }

  private onRequestFailed(req: Request): void {
    try {
      if (this.config.skipResourceTypes.includes(req.resourceType())) return;
      const id = this.requestTag.get(req);
      if (!id) return;
      const partial = this.inflight.get(id);
      if (!partial) return;
      this.inflight.delete(id);

      const failureText = req.failure()?.errorText;
      const entry: NetworkLogEntry = {
        t: partial.t || new Date().toISOString(),
        id,
        sessionId: this.sessionId,
        method: partial.method || req.method(),
        url: partial.url || req.url(),
        reqHeaders: partial.reqHeaders || {},
        reqBody: partial.reqBody ?? null,
        reqBodyBytes: partial.reqBodyBytes ?? 0,
        failed: true,
        timing: { duration_ms: Date.now() - (partial.startedAt || Date.now()) },
        ...(failureText ? { failureText } : {})
      };

      this.record(entry);
    } catch (err) {
      Logger.error(`[network-logger ${this.sessionId}] onRequestFailed error`, err);
    }
  }

  private record(entry: NetworkLogEntry): void {
    // in-memory ring buffer
    this.buffer.push(entry);
    this.byId.set(entry.id, entry);
    while (this.buffer.length > this.config.memoryBufferSize) {
      const dropped = this.buffer.shift();
      if (dropped) this.byId.delete(dropped.id);
    }

    // persist to disk
    const stream = this.ensureStream();
    if (stream) {
      try {
        stream.write(JSON.stringify(entry) + '\n');
      } catch (err) {
        Logger.error(`[network-logger ${this.sessionId}] serialize error`, err);
      }
    }
  }

  /**
   * Query entries from the in-memory buffer. Returns metadata only (no bodies) so
   * callers scanning for interesting requests don't copy large payloads unnecessarily.
   * Use getById for full detail.
   */
  public query(opts: {
    filter?: string;
    method?: string;
    since?: string;
    status?: number;
    failed?: boolean;
    limit?: number;
  } = {}): Array<Omit<NetworkLogEntry, 'reqBody' | 'respBody'> & { reqBodyPresent: boolean; respBodyPresent: boolean }> {
    const limit = Math.min(opts.limit ?? 100, 1000);
    const sinceMs = opts.since ? Date.parse(opts.since) : null;
    const methodFilter = opts.method ? opts.method.toUpperCase() : null;
    const urlFilter = opts.filter ? opts.filter.toLowerCase() : null;
    const results: Array<Omit<NetworkLogEntry, 'reqBody' | 'respBody'> & { reqBodyPresent: boolean; respBodyPresent: boolean }> = [];
    for (let i = this.buffer.length - 1; i >= 0 && results.length < limit; i--) {
      const e = this.buffer[i];
      if (!e) continue;
      if (sinceMs != null && !Number.isNaN(sinceMs) && Date.parse(e.t) < sinceMs) break; // buffer is time-ordered
      if (methodFilter && e.method.toUpperCase() !== methodFilter) continue;
      if (urlFilter && !e.url.toLowerCase().includes(urlFilter)) continue;
      if (opts.status != null && e.respStatus !== opts.status) continue;
      if (opts.failed != null && !!e.failed !== opts.failed) continue;
      const { reqBody, respBody, ...meta } = e;
      results.push({ ...meta, reqBodyPresent: reqBody != null, respBodyPresent: respBody != null });
    }
    return results;
  }

  public getById(id: string): NetworkLogEntry | null {
    return this.byId.get(id) || null;
  }

  /**
   * Build a minimal HAR 1.2-ish document from the in-memory buffer so a user can
   * open it in Burp / HTTP Toolkit / DevTools. Bodies are included when present.
   */
  public toHAR(): object {
    const entries = this.buffer.map(e => ({
      startedDateTime: e.t,
      time: e.timing?.duration_ms ?? 0,
      request: {
        method: e.method,
        url: e.url,
        httpVersion: 'HTTP/2',
        cookies: [],
        headers: Object.entries(e.reqHeaders).map(([name, value]) => ({ name, value })),
        queryString: safeQuery(e.url),
        postData: e.reqBody
          ? { mimeType: e.reqHeaders['content-type'] || 'text/plain', text: e.reqBody }
          : undefined,
        headersSize: -1,
        bodySize: e.reqBodyBytes ?? -1
      },
      response: {
        status: e.respStatus ?? 0,
        statusText: '',
        httpVersion: 'HTTP/2',
        cookies: [],
        headers: Object.entries(e.respHeaders || {}).map(([name, value]) => ({ name, value })),
        content: {
          size: e.respBodyBytes ?? -1,
          mimeType: e.respCT || 'application/octet-stream',
          text: e.respBody ?? undefined
        },
        redirectURL: '',
        headersSize: -1,
        bodySize: e.respBodyBytes ?? -1
      },
      cache: {},
      timings: { send: 0, wait: e.timing?.duration_ms ?? 0, receive: 0 }
    }));

    return {
      log: {
        version: '1.2',
        creator: { name: 'stealth-browser-v2', version: '2.0.0' },
        pages: [],
        entries
      }
    };
  }

  public async close(): Promise<void> {
    this.closed = true;
    if (this.writeStream) {
      const stream = this.writeStream;
      this.writeStream = null;
      await new Promise<void>(resolve => stream.end(() => resolve()));
    }
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
