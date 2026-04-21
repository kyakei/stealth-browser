/**
 * Lightweight curl command parser.
 *
 * Handles the "Copy as cURL (bash)" output that Chrome/Firefox DevTools produce:
 *   curl 'https://host/path' \
 *     -H 'Header: value' \
 *     -H 'Cookie: k1=v1; k2=v2' \
 *     --data-raw '{"k":"v"}' \
 *     --compressed
 *
 * Not a general shell parser — we tokenize what DevTools emits (single-quoted
 * strings, long/short flags, backslash line continuations). Good enough for
 * extracting URL, method, headers, body, and cookies.
 */

import { CurlParsed } from './types';

function unquote(s: string): string {
  if (s.length >= 2) {
    const first = s[0];
    const last = s[s.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return s.slice(1, -1);
    }
  }
  return s;
}

/**
 * Tokenize a curl command respecting single/double quotes and backslash
 * continuations. Returns the bare tokens (quotes stripped).
 */
function tokenize(cmd: string): string[] {
  const normalized = cmd.replace(/\\\s*\n/g, ' ').trim();
  const tokens: string[] = [];
  let i = 0;
  while (i < normalized.length) {
    const ch = normalized[i];
    if (ch === undefined) break;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const quote = ch;
      const start = i;
      i++;
      while (i < normalized.length && normalized[i] !== quote) {
        if (normalized[i] === '\\' && normalized[i + 1] !== undefined) i++;
        i++;
      }
      tokens.push(unquote(normalized.slice(start, i + 1)));
      i++;
    } else {
      const start = i;
      while (
        i < normalized.length &&
        normalized[i] !== ' ' &&
        normalized[i] !== '\t' &&
        normalized[i] !== "'" &&
        normalized[i] !== '"'
      ) {
        i++;
      }
      tokens.push(normalized.slice(start, i));
    }
  }
  return tokens;
}

/**
 * Parse `k1=v1; k2=v2` style Cookie header into a flat map.
 */
export function parseCookieHeader(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of raw.split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const name = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (name) out[name] = value;
  }
  return out;
}

/**
 * Parse a cURL command and extract URL, method, headers, cookies, body.
 */
export function parseCurl(curlCmd: string): CurlParsed {
  const tokens = tokenize(curlCmd).filter(t => t.length > 0);
  if (tokens[0]?.toLowerCase() === 'curl') tokens.shift();

  const headers: Record<string, string> = {};
  let url = '';
  let method = 'GET';
  let body: string | null = null;

  const takeNext = (i: number): string | undefined => tokens[i + 1];

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === undefined) continue;

    switch (t) {
      case '-H':
      case '--header': {
        const raw = takeNext(i);
        if (raw) {
          const colon = raw.indexOf(':');
          if (colon > 0) {
            const name = raw.slice(0, colon).trim();
            const value = raw.slice(colon + 1).trim();
            headers[name] = value;
          }
        }
        i++;
        break;
      }
      case '-X':
      case '--request': {
        const m = takeNext(i);
        if (m) method = m.toUpperCase();
        i++;
        break;
      }
      case '-d':
      case '--data':
      case '--data-raw':
      case '--data-binary':
      case '--data-urlencode': {
        const raw = takeNext(i);
        if (raw !== undefined) body = raw;
        if (method === 'GET') method = 'POST';
        i++;
        break;
      }
      case '-b':
      case '--cookie': {
        const raw = takeNext(i);
        if (raw) headers['Cookie'] = (headers['Cookie'] ? headers['Cookie'] + '; ' : '') + raw;
        i++;
        break;
      }
      case '--compressed':
      case '-L':
      case '--location':
      case '-k':
      case '--insecure':
      case '-i':
      case '--include':
      case '-s':
      case '--silent':
      case '-v':
      case '--verbose':
      case '-I':
      case '--head':
        break;
      case '-u':
      case '--user':
      case '-A':
      case '--user-agent':
      case '-e':
      case '--referer':
      case '-o':
      case '--output':
      case '--cacert':
      case '--cert':
      case '--key':
      case '--proxy':
      case '--max-time':
      case '--connect-timeout':
        i++; // skip the flag's value
        break;
      default:
        // Positional URL — accept the first http(s) argument we see.
        if (!url && /^https?:\/\//i.test(t)) {
          url = t;
        }
        break;
    }
  }

  const cookieHeader = headers['Cookie'] || headers['cookie'];
  const cookies = cookieHeader ? parseCookieHeader(cookieHeader) : {};

  return { url, method, headers, cookies, body };
}

/**
 * Convert a plain `Cookie: k1=v1; k2=v2` header string (or just the value portion)
 * into Playwright cookie objects bound to `domain`.
 */
export function cookieHeaderToPlaywright(
  cookieHeader: string,
  domain: string,
  opts: { path?: string; secure?: boolean; httpOnly?: boolean; sameSite?: 'Strict' | 'Lax' | 'None' } = {}
): Array<{ name: string; value: string; domain: string; path: string; httpOnly: boolean; secure: boolean; sameSite: 'Strict' | 'Lax' | 'None' }> {
  const raw = cookieHeader.replace(/^\s*cookie\s*:\s*/i, '');
  const parsed = parseCookieHeader(raw);
  return Object.entries(parsed).map(([name, value]) => ({
    name,
    value,
    domain: domain.startsWith('.') ? domain : '.' + domain.replace(/^www\./, ''),
    path: opts.path || '/',
    httpOnly: opts.httpOnly ?? true,
    secure: opts.secure ?? true,
    sameSite: opts.sameSite || 'Lax'
  }));
}
