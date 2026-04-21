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
    description: 'Get all cookies for a headless session (by sessionId). For attach-mode cookies, use browser_eval_js with document.cookie or export via sync-to-session.',
    inputSchema: {
      type: 'object',
      properties: { sessionId: { type: 'string' } },
      required: ['sessionId'],
      additionalProperties: false,
    },
    handler: ({ sessionId }) => httpRequest('GET', `/v2/sessions/${encodeURIComponent(sessionId)}/cookies`),
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
