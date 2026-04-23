#!/usr/bin/env node
// MCP server wrapping stealth-browser-v2's HTTP API (localhost:7331).
// Exposes attach-mode + session-mode tools as structured MCP calls so
// Claude Code can drive the persistent stealth Chrome without shelling
// out to the CLI.
//
// Usage (stdio transport): node index.js
// Prereq: stealth-browser-v2 must be running:
//   xvfb-run -a node ~/tools/stealth-browser-v2/bin/start.sh &

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const BASE = process.env.STEALTH_BROWSER_URL || 'http://localhost:7331';
const DEFAULT_TIMEOUT_MS = 60_000;

async function httpRequest(method, path, { body, query } = {}) {
  const url = new URL(path, BASE);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
  if (!res.ok) {
    const err = parsed?.error?.message || parsed?.error || text;
    throw new Error(`[${res.status}] ${err}`);
  }
  return parsed;
}

// Tool definitions. Each is { name, description, inputSchema, handler }.
// inputSchema is JSON Schema shape for MCP.
const TOOLS = [
  {
    name: 'browser_health',
    description: 'Check stealth-browser-v2 server health. Returns {running, version, uptime}. Call this first to confirm the server is up before other browser tools.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: () => httpRequest('GET', '/v2/health'),
  },
  {
    name: 'browser_attach',
    description: 'Attach Playwright to the persistent visible Chrome instance (for human-in-the-loop steps like MFA, captcha). Optionally navigates to `url`. Returns status + currentUrl. Call browser_detach when done.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Optional URL to navigate to immediately after attach.' },
        sourceSessionId: { type: 'string', description: 'Optional headless session id to import cookies/localStorage from.' },
      },
      additionalProperties: false,
    },
    handler: (args) => httpRequest('POST', '/v2/attach', { body: args }),
  },
  {
    name: 'browser_detach',
    description: 'Detach from the attached Chrome. Call after completing manual interaction. Does NOT close the browser; just stops Playwright driving it.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: () => httpRequest('POST', '/v2/detach'),
  },
  {
    name: 'browser_attach_status',
    description: 'Get current attach-mode status: {running, browserWSEndpoint, currentUrl, ...}.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: () => httpRequest('GET', '/v2/attach/status'),
  },
  {
    name: 'browser_navigate',
    description: 'Navigate the attached tab to a URL. Requires active attach. Returns {currentUrl, title}.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        waitUntil: { type: 'string', enum: ['load', 'domcontentloaded', 'networkidle', 'commit'], default: 'domcontentloaded' },
        timeout: { type: 'integer', default: 30000 },
      },
      required: ['url'],
      additionalProperties: false,
    },
    handler: (args) => httpRequest('POST', '/v2/attach/navigate', { body: args }),
  },
  {
    name: 'browser_eval_js',
    description: 'Evaluate arbitrary JavaScript in the attached tab and return the result. Script may be an expression or a block with `return`. Use for DOM inspection, state reads, or extracting tokens.',
    inputSchema: {
      type: 'object',
      properties: {
        script: { type: 'string', description: 'JS source. Expression or block returning a value.' },
        arg: { description: 'Optional arg passed into the block as `__arg`.' },
      },
      required: ['script'],
      additionalProperties: false,
    },
    handler: (args) => httpRequest('POST', '/v2/attach/eval', { body: args }),
  },
  {
    name: 'browser_page_text',
    description: 'Get innerText + title + url of the attached tab, trimmed to `limit` chars (default 8000, max 30000). Useful for reading page content.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', default: 8000, minimum: 100, maximum: 30000 },
      },
      additionalProperties: false,
    },
    handler: ({ limit } = {}) => httpRequest('GET', '/v2/attach/page-text', { query: { limit } }),
  },
  {
    name: 'browser_click_text',
    description: 'Click the first element whose visible text matches (contains) the given string. Simpler than writing a CSS selector.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
      additionalProperties: false,
    },
    handler: (args) => httpRequest('POST', '/v2/attach/click-text', { body: args }),
  },
  {
    name: 'browser_click_selector',
    description: 'Click the element matching a CSS selector on the attached tab.',
    inputSchema: {
      type: 'object',
      properties: { selector: { type: 'string' } },
      required: ['selector'],
      additionalProperties: false,
    },
    handler: (args) => httpRequest('POST', '/v2/attach/click', { body: args }),
  },
  {
    name: 'browser_type',
    description: 'Type text into an input matching `selector`. Use `clear: true` to wipe existing value first.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string' },
        text: { type: 'string' },
        delay: { type: 'integer', description: 'ms between keystrokes' },
        clear: { type: 'boolean', default: false },
      },
      required: ['selector', 'text'],
      additionalProperties: false,
    },
    handler: (args) => httpRequest('POST', '/v2/attach/type', { body: args }),
  },
  {
    name: 'browser_keyboard_type',
    description: 'Send raw CDP keystrokes. Use for React-controlled inputs where setter+input events do not update framework state (i.e. when browser_type fails to register).',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'Optional selector to focus first.' },
        text: { type: 'string' },
        delay: { type: 'integer' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    handler: (args) => httpRequest('POST', '/v2/attach/keyboard-type', { body: args }),
  },
  {
    name: 'browser_form_snapshot',
    description: 'Return all form fields + buttons on the attached tab. Useful for discovering inputs before typing.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: () => httpRequest('GET', '/v2/attach/form'),
  },
  {
    name: 'browser_list_tabs',
    description: 'List all open tabs in the attached Chrome with {id, url, title}.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: () => httpRequest('GET', '/v2/attach/tabs'),
  },
  {
    name: 'browser_select_tab',
    description: 'Switch focus to the first tab whose URL contains `urlSubstring`.',
    inputSchema: {
      type: 'object',
      properties: { urlSubstring: { type: 'string' } },
      required: ['urlSubstring'],
      additionalProperties: false,
    },
    handler: (args) => httpRequest('POST', '/v2/attach/select-tab', { body: args }),
  },
  {
    name: 'browser_network_query',
    description: 'Query captured network requests from the attached tab (metadata only). Filter by URL substring, HTTP method, status code, timestamp, limit.',
    inputSchema: {
      type: 'object',
      properties: {
        filter: { type: 'string', description: 'URL substring to match' },
        method: { type: 'string', description: 'GET, POST, PUT, DELETE, etc.' },
        status: { type: 'integer', description: 'HTTP status code' },
        since: { type: 'string', description: 'ISO timestamp — return only requests after this' },
        limit: { type: 'integer', default: 100, maximum: 1000 },
      },
      additionalProperties: false,
    },
    handler: (args) => httpRequest('GET', '/v2/attach/network', { query: args }),
  },
  {
    name: 'browser_network_entry',
    description: 'Get the full captured request+response (headers + bodies) for one network entry by id (from browser_network_query).',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
    handler: ({ id }) => httpRequest('GET', `/v2/attach/network/${encodeURIComponent(id)}`),
  },
  {
    name: 'browser_network_clear',
    description: 'Clear the captured network log for the attached tab. Returns number of entries cleared.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: () => httpRequest('POST', '/v2/attach/network/clear'),
  },
  {
    name: 'browser_cookies_get',
    description: 'Get all cookies for a headless session (by sessionId). For attach-mode cookies, use browser_cookies_get_attached instead.',
    inputSchema: {
      type: 'object',
      properties: { sessionId: { type: 'string' } },
      required: ['sessionId'],
      additionalProperties: false,
    },
    handler: ({ sessionId }) => httpRequest('GET', `/v2/sessions/${encodeURIComponent(sessionId)}/cookies`),
  },
  {
    name: 'browser_cookies_get_attached',
    description: 'Read cookies from the attached Chrome. Includes HttpOnly cookies (unlike document.cookie via browser_eval_js). Optional substring filter on domain and exact match on name. Use this to enumerate session cookies like Slack d= / d-s.',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Substring match on cookie domain (e.g. ".slack.com")' },
        name: { type: 'string', description: 'Exact cookie name' },
      },
      additionalProperties: false,
    },
    handler: (args = {}) => httpRequest('GET', '/v2/attach/cookies', { query: args }),
  },
  {
    name: 'browser_cookies_delete',
    description: 'Delete cookies from the attached Chrome matching filters. At least one of {domain, name, path} required — prevents accidental whole-jar wipes. Use when you need to isolate a workspace session without manually signing out.',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Substring match on cookie domain' },
        name: { type: 'string', description: 'Exact cookie name' },
        path: { type: 'string', description: 'Exact cookie path' },
      },
      additionalProperties: false,
    },
    handler: (args) => httpRequest('POST', '/v2/attach/cookies/delete', { body: args }),
  },
  {
    name: 'browser_cookies_snapshot',
    description: 'Save the current attached-Chrome cookie jar under `name` for later diffing. Snapshots are in-memory (lost on server restart). Overwrites if name exists.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
      additionalProperties: false,
    },
    handler: (args) => httpRequest('POST', '/v2/attach/cookies/snapshot', { body: args }),
  },
  {
    name: 'browser_cookies_diff',
    description: 'Diff two cookie snapshots, or a snapshot vs current. Returns {added, removed, changed}. Use to see exactly which cookies a login/flow sets.',
    inputSchema: {
      type: 'object',
      properties: {
        before: { type: 'string', description: 'Name of "before" snapshot' },
        after: { type: 'string', description: 'Name of "after" snapshot. Defaults to live jar.', default: 'current' },
      },
      required: ['before'],
      additionalProperties: false,
    },
    handler: (args) => httpRequest('GET', '/v2/attach/cookies/diff', { query: args }),
  },
  {
    name: 'browser_wait_for',
    description: 'Wait until the attached tab contains `text` or matches `selector`. Timeout in ms (default 10000). Use instead of shell sleep after browser_navigate. Provide exactly one of text/selector.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Substring to wait for in document.body.innerText' },
        selector: { type: 'string', description: 'CSS selector to wait for' },
        timeout: { type: 'integer', default: 10000 },
      },
      additionalProperties: false,
    },
    handler: (args) => httpRequest('POST', '/v2/attach/wait-for', { body: args }),
  },
  {
    name: 'browser_screenshot',
    description: 'Capture the attached tab as PNG. Returns {bytes, path?, base64?}. Inline base64 is suppressed by default when `path` is set (a fullPage PNG is ~100KB+ and overflows MCP tool-result budgets). Set returnBase64:true to force inline; set returnBase64:false to suppress even without a path.',
    inputSchema: {
      type: 'object',
      properties: {
        fullPage: { type: 'boolean', default: false },
        path: { type: 'string', description: 'Optional absolute path to save PNG' },
        selector: { type: 'string', description: 'Optional CSS selector — screenshot just that element' },
        returnBase64: { type: 'boolean', description: 'Force/suppress inline base64. Default: inline only when path is unset.' },
      },
      additionalProperties: false,
    },
    handler: (args = {}) => httpRequest('POST', '/v2/attach/screenshot', { body: args }),
  },
  {
    name: 'browser_dom_snapshot',
    description: 'Capture the attached tab\'s full serialized HTML. Optional `path` writes to disk. Returns {html, bytes, path?}. Useful for post-hoc analysis and report evidence.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Optional absolute path to save HTML' },
      },
      additionalProperties: false,
    },
    handler: (args = {}) => httpRequest('POST', '/v2/attach/dom-snapshot', { body: args }),
  },
  {
    name: 'browser_extract_tokens',
    description: 'Scan the attached tab for Slack xox* tokens and boot_data.api_token in localStorage + window globals + page source. Always returns all 8 keys: {xoxc, xoxs, xoxb, xoxd, xoxp, bootDataApiToken} each string-or-null, plus otherXoxTokens: string[] and source: Record<string,string> (maps each found key to where it was found).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: () => httpRequest('GET', '/v2/attach/tokens'),
  },
  {
    name: 'browser_har_export',
    description: 'Export the attached-tab network log as HAR 1.2 JSON. Ready to import into Burp / HTTP Toolkit / DevTools. Includes response bodies (after #19 CDP body-capture fix).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: () => httpRequest('GET', '/v2/attach/har'),
  },

  // #4 / #22 — Named / incognito contexts
  {
    name: 'browser_contexts_list',
    description: 'List all browser contexts (cookie jars) on the attached browser. Default context + any named contexts created via browser_context_create. Each shows pages, cookie count, creation time.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: () => httpRequest('GET', '/v2/attach/contexts'),
  },
  {
    name: 'browser_context_create',
    description: 'Create a fresh BrowserContext with its own cookie jar. In attached Chrome this opens a separate window. Use to run WS1 + WS2 sessions side-by-side with zero cookie bleed.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Handle for this context (cannot be "default")' } },
      required: ['name'],
      additionalProperties: false,
    },
    handler: (args) => httpRequest('POST', '/v2/attach/contexts', { body: args }),
  },
  {
    name: 'browser_context_close',
    description: 'Close a named context (does NOT affect the default context or detach Chrome).',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
      additionalProperties: false,
    },
    handler: (args) => httpRequest('POST', '/v2/attach/contexts/close', { body: args }),
  },
  {
    name: 'browser_context_navigate',
    description: "Navigate within a named context's first page.",
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        url: { type: 'string' },
        waitUntil: { type: 'string', enum: ['load', 'domcontentloaded', 'networkidle', 'commit'], default: 'domcontentloaded' },
        timeout: { type: 'number', default: 30000 },
      },
      required: ['name', 'url'],
      additionalProperties: false,
    },
    handler: (args) => httpRequest('POST', '/v2/attach/contexts/navigate', { body: args }),
  },
  {
    name: 'browser_context_cookies',
    description: 'Read cookies from a specific context (default or named). Same filter args as browser_cookies_get_attached.',
    inputSchema: {
      type: 'object',
      properties: {
        context: { type: 'string', default: 'default' },
        domain: { type: 'string' },
        name: { type: 'string' },
      },
      additionalProperties: false,
    },
    handler: (args) => httpRequest('GET', '/v2/attach/contexts/cookies', { query: args }),
  },

  // #2 — Env cookie loader
  {
    name: 'browser_cookies_load_file',
    description: 'Load cookies into an attached context from a file. Supports JSON (array or {cookies:[...]}) OR env format: "# domain=X", "# path=/", "# secure", "# httpOnly" directive lines, then "name=value" pairs.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to cookie file' },
        context: { type: 'string', default: 'default' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    handler: (args) => httpRequest('POST', '/v2/attach/cookies/load-file', { body: args }),
  },
  {
    name: 'browser_cookies_export_file',
    description: 'Write current-context cookies (filtered to `domain`) out to a file in the env format that browser_cookies_load_file understands. Round-trippable.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        context: { type: 'string', default: 'default' },
        domain: { type: 'string', description: 'Only export cookies for this domain (or parents)' },
      },
      required: ['path', 'domain'],
      additionalProperties: false,
    },
    handler: (args) => httpRequest('POST', '/v2/attach/cookies/export-file', { body: args }),
  },

  // #1 / #20 — WebSocket capture + send
  {
    name: 'browser_ws_list',
    description: 'List WebSocket connections captured from the attached tabs. Returns url, handshake status, frame count, open/closed state.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: () => httpRequest('GET', '/v2/attach/ws'),
  },
  {
    name: 'browser_ws_detail',
    description: 'Full detail (handshake headers + all captured frames) for a single WebSocket connection by id (from browser_ws_list).',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
    handler: ({ id }) => httpRequest('GET', `/v2/attach/ws/${encodeURIComponent(id)}`),
  },
  {
    name: 'browser_ws_frames',
    description: 'Flat cross-connection frame query. Filter by connectionId, direction (in|out), substring match, limit.',
    inputSchema: {
      type: 'object',
      properties: {
        connectionId: { type: 'string' },
        direction: { type: 'string', enum: ['in', 'out'] },
        contains: { type: 'string' },
        limit: { type: 'number' },
      },
      additionalProperties: false,
    },
    handler: (args) => httpRequest('GET', '/v2/attach/ws/frames', { query: args }),
  },
  {
    name: 'browser_ws_send',
    description: 'Inject a frame on every open WebSocket whose url contains the given substring. Implementation: calls WebSocket.send() via page.evaluate on each matching WS the page opened (an init-script proxy keeps them in a registry). Use for replay, mutation, subscription hijack tests.',
    inputSchema: {
      type: 'object',
      properties: {
        urlContains: { type: 'string' },
        payload: { type: 'string' },
        context: { type: 'string', default: 'default' },
      },
      required: ['urlContains', 'payload'],
      additionalProperties: false,
    },
    handler: (args) => httpRequest('POST', '/v2/attach/ws/send', { body: args }),
  },

  // #3 / #23 — Request + response intercept
  {
    name: 'browser_intercept_enable',
    description: 'Turn on Burp-style request/response interception on the default context. Matching rule: urlContains, urlRegex, method. Direction: request (pause before send), response (pause after server reply), both. Paused items appear in browser_intercept_status.pending; forward or drop each to release.',
    inputSchema: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['request', 'response', 'both'] },
        urlContains: { type: 'string' },
        urlRegex: { type: 'string' },
        method: { type: 'string' },
      },
      required: ['direction'],
      additionalProperties: false,
    },
    handler: (args) => httpRequest('POST', '/v2/attach/intercept/enable', { body: args }),
  },
  {
    name: 'browser_intercept_status',
    description: 'Current intercept rule + list of paused requests/responses waiting for forward/drop.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: () => httpRequest('GET', '/v2/attach/intercept'),
  },
  {
    name: 'browser_intercept_forward',
    description: 'Release a paused intercepted item by id. Request-phase: optionally override method/url/headers/body. Response-phase: optionally override status/headers/body.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        method: { type: 'string' },
        url: { type: 'string' },
        headers: { type: 'object' },
        body: { type: 'string' },
        status: { type: 'number' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    handler: (args) => httpRequest('POST', '/v2/attach/intercept/forward', { body: args }),
  },
  {
    name: 'browser_intercept_drop',
    description: 'Abort a paused intercepted item (client receives ERR_BLOCKED_BY_CLIENT).',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
    handler: (args) => httpRequest('POST', '/v2/attach/intercept/drop', { body: args }),
  },
  {
    name: 'browser_intercept_disable',
    description: 'Uninstall intercept rule; any pending items get auto-forwarded.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: () => httpRequest('POST', '/v2/attach/intercept/disable'),
  },
];

const server = new Server(
  { name: 'stealth-browser-mcp', version: '0.1.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map(({ name, description, inputSchema }) => ({
    name, description, inputSchema,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const tool = TOOLS.find((t) => t.name === req.params.name);
  if (!tool) {
    return {
      isError: true,
      content: [{ type: 'text', text: `Unknown tool: ${req.params.name}` }],
    };
  }
  try {
    const result = await tool.handler(req.params.arguments || {});
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    return {
      isError: true,
      content: [{ type: 'text', text: `Error: ${err.message}` }],
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
