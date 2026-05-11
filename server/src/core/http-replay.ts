import * as https from 'https';
import * as http from 'http';
import { Page } from 'playwright';
import { Logger } from '@utils/logger';

/**
 * browser_replay_http — fire raw HTTP requests *outside* the per-nav browser
 * loop, reusing the attached session. The "browser for auth, fast HTTP for
 * bulk" combo: log in once with the visible Chrome, then hammer 10k object IDs
 * to find an IDOR/BOLA pattern without a page-load per request.
 *
 * Two execution paths:
 *   - same-origin (relative to the current tab's URL) → runs inside the page via
 *     fetch() in a single page.evaluate with a concurrency pool. Cookies are
 *     automatic, the TLS fingerprint is real Chrome, zero browser overhead per
 *     request. This is the default and the recommended path for IDOR enum.
 *   - cross-origin → done server-side with Node's http/https, pulling cookies
 *     from the browser context for the target origin and sending Chrome-ish
 *     headers. (No JA3 spoof here — if a target gates on TLS fingerprint, use
 *     the same-origin/page path instead, or proxy through curl-impersonate.)
 *
 * Targets can be: a single `url`; an explicit `urls[]`; or a template via
 * `idRange:{from,to,placeholder}` where the placeholder string in `url` (or in
 * `idRange.url`) is replaced by each integer in [from,to].
 */

export interface ReplayOpts {
  method?: string;
  url?: string;
  urls?: string[];
  idRange?: { from: number; to: number; placeholder?: string; url?: string };
  headers?: Record<string, string>;
  body?: string;
  concurrency?: number;
  maxResponses?: number;     // hard cap on how many requests to fire
  bodyLimit?: number;        // truncate each response body to this many chars
  forceServerSide?: boolean; // skip the in-page path even for same-origin
}

export interface ReplayResultRow {
  url: string;
  status?: number | undefined;
  ok?: boolean | undefined;
  headers?: Record<string, string> | undefined;
  bodyLen?: number | undefined;
  body?: string | undefined;             // truncated
  ms: number;
  error?: string | undefined;
}

export interface ReplayResult {
  count: number;
  viaBrowser: boolean;
  results: ReplayResultRow[];
}

function buildTargets(o: ReplayOpts): string[] {
  if (o.urls && o.urls.length) return o.urls.slice();
  if (o.idRange) {
    const tmpl = o.idRange.url || o.url;
    if (!tmpl) throw new Error('idRange given but no template `url`');
    const ph = o.idRange.placeholder || '{id}';
    if (!tmpl.includes(ph)) throw new Error(`template url does not contain placeholder ${ph}`);
    const { from, to } = o.idRange;
    if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) throw new Error('bad idRange');
    const out: string[] = [];
    for (let i = from; i <= to; i++) out.push(tmpl.split(ph).join(String(i)));
    return out;
  }
  if (o.url) return [o.url];
  throw new Error('provide url, urls, or idRange');
}

function isSameOrigin(target: string, base: string): boolean {
  try { return new URL(target, base).origin === new URL(base).origin; } catch { return false; }
}

export async function replayHttp(page: Page, opts: ReplayOpts): Promise<ReplayResult> {
  const method = (opts.method || 'GET').toUpperCase();
  const headers = opts.headers || {};
  const body = opts.body;
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? 10, 50));
  const maxResponses = Math.min(opts.maxResponses ?? 1000, 20000);
  const bodyLimit = Math.min(opts.bodyLimit ?? 2000, 100000);
  const baseUrl = page.url();

  const targetsAbs = buildTargets(opts).map(u => { try { return new URL(u, baseUrl).href; } catch { return u; } });
  if (targetsAbs.length > maxResponses) {
    throw new Error(`${targetsAbs.length} targets exceeds maxResponses=${maxResponses}; raise maxResponses or narrow the range`);
  }

  const allSameOrigin = targetsAbs.every(u => isSameOrigin(u, baseUrl));
  const viaBrowser = allSameOrigin && !opts.forceServerSide;

  if (viaBrowser) {
    Logger.info('replayHttp: in-page fetch path', { count: targetsAbs.length, method, concurrency });
    const results = await page.evaluate(async ({ urls, method, headers, body, concurrency, bodyLimit }) => {
      const out: any[] = new Array(urls.length);
      let idx = 0;
      const worker = async () => {
        while (true) {
          const i = idx++;
          if (i >= urls.length) return;
          const t0 = performance.now();
          try {
            const init: RequestInit = { method, headers: headers as any, credentials: 'include', redirect: 'manual' };
            if (method !== 'GET' && method !== 'HEAD' && typeof body === 'string') init.body = body;
            const r = await fetch(urls[i]!, init);
            const text = await r.text();
            const h: Record<string, string> = {};
            r.headers.forEach((v, k) => { h[k] = v; });
            out[i] = { url: urls[i]!, status: r.status, ok: r.ok, headers: h, bodyLen: text.length, body: text.slice(0, bodyLimit as number), ms: Math.round(performance.now() - t0) };
          } catch (e: any) {
            out[i] = { url: urls[i]!, ms: Math.round(performance.now() - t0), error: String(e && e.message || e) };
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(concurrency as number, urls.length) }, worker));
      return out;
    }, { urls: targetsAbs, method, headers, body, concurrency, bodyLimit });
    return { count: targetsAbs.length, viaBrowser: true, results };
  }

  // Server-side path — pull cookies from the context for each origin, send with Chrome-ish headers.
  Logger.info('replayHttp: server-side path (cross-origin)', { count: targetsAbs.length, method });
  const ctx = page.context();
  const ua = await page.evaluate(() => navigator.userAgent).catch(() => 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36');
  const cookieHeaderFor = async (u: string): Promise<string> => {
    try {
      const cs = await ctx.cookies(u);
      return cs.map(c => `${c.name}=${c.value}`).join('; ');
    } catch { return ''; }
  };

  const errStr = (e: any): string => (e && (e.code || e.message)) ? `${e.code ? '[' + e.code + '] ' : ''}${e.message || ''}`.trim() || String(e) : String(e);

  const doOne = async (u: string): Promise<ReplayResultRow> => {
    const t0 = Date.now();
    let parsed: URL;
    try { parsed = new URL(u); } catch { return { url: u, ms: 0, error: 'bad url' }; }
    let cookieHeader = '';
    try { cookieHeader = await cookieHeaderFor(parsed.origin); } catch { /* ignore */ }
    const reqHeaders: Record<string, string> = {
      'User-Agent': ua,
      'Accept': '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      ...(cookieHeader ? { 'Cookie': cookieHeader } : {}),
      ...headers,
    };
    if (body && method !== 'GET' && method !== 'HEAD' && !Object.keys(reqHeaders).some(k => k.toLowerCase() === 'content-type')) {
      reqHeaders['Content-Type'] = 'application/json';
    }
    const lib = parsed.protocol === 'http:' ? http : https;
    return new Promise<ReplayResultRow>((resolve) => {
      let done = false;
      const finish = (row: ReplayResultRow) => { if (!done) { done = true; resolve(row); } };
      const reqOpts: http.RequestOptions = {
        method,
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'http:' ? 80 : 443),
        path: parsed.pathname + parsed.search,
        headers: reqHeaders,
        timeout: 20000,
        // Force IPv4 — this box has no working IPv6 route, and Node (unlike curl,
        // which does Happy Eyeballs) will hang on the AAAA attempt → ETIMEDOUT.
        family: 4,
      };
      const req = lib.request(reqOpts, (res) => {
        const chunks: Buffer[] = [];
        let total = 0;
        res.on('data', (c: Buffer) => { total += c.length; if (chunks.reduce((a, b) => a + b.length, 0) < bodyLimit + 8192) chunks.push(c); });
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          const h: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) h[k] = Array.isArray(v) ? v.join(', ') : String(v ?? '');
          finish({ url: u, status: res.statusCode, ok: !!res.statusCode && res.statusCode < 400, headers: h, bodyLen: total, body: text.slice(0, bodyLimit), ms: Date.now() - t0 });
        });
        res.on('error', (e) => finish({ url: u, ms: Date.now() - t0, error: 'res: ' + errStr(e) }));
      });
      req.on('timeout', () => { req.destroy(); finish({ url: u, ms: Date.now() - t0, error: 'timeout' }); });
      req.on('error', (e) => finish({ url: u, ms: Date.now() - t0, error: errStr(e) }));
      if (body && method !== 'GET' && method !== 'HEAD') req.write(body);
      req.end();
    });
  };

  // Concurrency pool, server-side.
  const results: ReplayResultRow[] = new Array(targetsAbs.length);
  let i = 0;
  const worker = async () => { while (true) { const k = i++; if (k >= targetsAbs.length) return; results[k] = await doOne(targetsAbs[k]!); } };
  await Promise.all(Array.from({ length: Math.min(concurrency, targetsAbs.length) }, worker));
  return { count: targetsAbs.length, viaBrowser: false, results };
}
