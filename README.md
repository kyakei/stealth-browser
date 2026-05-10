# stealth-browser

Playwright-based stealth browser automation with an MCP wrapper for Claude Code.

Drives a single, persistent, human-visible Chrome the way an AI agent actually wants to drive a browser: navigate it, type into it, scrape network traffic from it, hijack WebSockets, intercept requests Burp-style, snapshot/diff cookie jars, and auto-bypass captchas — all over a structured tool surface, while keeping the same window open so the human can step in for MFA or manual fixes mid-session.

## Highlights

- **Persistent attached Chrome** — driven via CDP. The window stays open across calls; the AI and the human share one tab, one cookie jar, one session.
- **Stealth-first** — `playwright-extra` + `puppeteer-extra-plugin-stealth` (fingerprint randomization, WebGL spoofing, UA rotation), launched headful under `xvfb` so basic anti-bot checks (`navigator.webdriver`, headless detection) don't trip.
- **Burp-style request/response intercept** — pause, mutate, drop, or forward live HTTP traffic from the AI tool surface.
- **WebSocket capture + injection** — list every WS the page opened, read every frame in/out, and inject your own frames on any open connection.
- **HAR export with response bodies** — drop the captured network log straight into Burp / HTTP Toolkit / DevTools.
- **Cookie tooling** — list (incl. HttpOnly), delete (guarded), snapshot, diff, JSON/env-format file load+export. Multiple named contexts for parallel cookie jars (e.g. user-A vs. user-B for IDOR checks).
- **2captcha-backed captcha solver** — auto-detect + auto-solve reCAPTCHA v2/v3, hCaptcha, Cloudflare Turnstile, DataDome, MTCaptcha, Friendly Captcha, AWS WAF. ~$0.003 + ~10s per reCAPTCHA v2.
- **Token extraction** — built-in scanner for `xox*` Slack tokens and `boot_data.api_token` across localStorage, window globals, and page source.

40+ MCP tools total. See [`mcp/index.js`](./mcp/index.js) for the full list.

## Architecture

```
Claude Code  <—stdio—>  mcp/index.js  <—HTTP—>  server (localhost:7331)  <—CDP—>  Chrome (Xvfb)
```

| Package | Role |
|---|---|
| [`server/`](./server) | Express HTTP+WebSocket server on `:7331`/`:7332`. Owns the persistent stealth Chrome, the CDP session, the network/WS log, named cookie contexts, intercept rules, and the captcha solver. |
| [`mcp/`](./mcp) | Thin MCP (Model Context Protocol) server. Translates the HTTP API into structured tool calls Claude Code (or any MCP client) can invoke over stdio. |

## Quick start

**1. Build + start the server:**

```bash
cd server
npm install
npm run build
xvfb-run -a node dist/index.js      # headful under xvfb (recommended for stealth)
# or, if you have a desktop session and want to watch:
node dist/index.js
```

The server listens on `http://localhost:7331`.

**2. Install the MCP wrapper:**

```bash
cd ../mcp
npm install
```

**3. Register the MCP server with Claude Code.**

Add to `~/.claude.json` under `mcpServers`:

```json
"stealth-browser": {
  "type": "stdio",
  "command": "node",
  "args": ["/absolute/path/to/stealth-browser/mcp/index.js"],
  "env": {}
}
```

Restart Claude Code — `mcp__stealth-browser__*` tools will appear.

**4. (Optional) Enable the captcha solver:**

```bash
cd server
cp .env.example .env
# edit .env and set TWOCAPTCHA_API_KEY=<your key>
```

The server loads `.env` via dotenv on startup. `.env` is gitignored.

## Tool surface (overview)

| Category | Tools |
|---|---|
| Lifecycle | `browser_health`, `browser_attach`, `browser_detach`, `browser_attach_status` |
| Navigation | `browser_navigate`, `browser_wait_for`, `browser_list_tabs`, `browser_select_tab` |
| Page read | `browser_page_text`, `browser_form_snapshot`, `browser_eval_js`, `browser_dom_snapshot`, `browser_screenshot` |
| Page interact | `browser_click_text`, `browser_click_selector`, `browser_type`, `browser_keyboard_type` |
| Network | `browser_network_query`, `browser_network_entry`, `browser_network_clear`, `browser_har_export` |
| WebSocket | `browser_ws_list`, `browser_ws_detail`, `browser_ws_frames`, `browser_ws_send` |
| Cookies | `browser_cookies_get_attached`, `browser_cookies_delete`, `browser_cookies_snapshot`, `browser_cookies_diff`, `browser_cookies_load_file`, `browser_cookies_export_file` |
| Multi-context | `browser_contexts_list`, `browser_context_create`, `browser_context_close`, `browser_context_navigate`, `browser_context_cookies` |
| Intercept (Burp) | `browser_intercept_enable`, `browser_intercept_status`, `browser_intercept_forward`, `browser_intercept_drop`, `browser_intercept_disable` |
| Tokens | `browser_extract_tokens` |
| Captcha | `browser_captcha_balance`, `browser_captcha_detect`, `browser_solve_captcha` |

## Captcha solver — supported types

| Type | Auto-detect | Proxy required | Cost (typical) |
|---|---|---|---|
| `recaptcha_v2` (checkbox) | ✓ | no | $0.003 |
| `recaptcha_v2_invisible` | ✓ | no | $0.003 |
| `recaptcha_v3` | ✓ (sitekey + script) | no | $0.003 |
| `hcaptcha` / `hcaptcha_invisible` | ✓ | no | $0.003 |
| `turnstile` (Cloudflare) | ✓ | no | $0.003 |
| `mtcaptcha` | ✓ | no | low |
| `friendly` | ✓ | no | low |
| `datadome` | ✓ (iframe URL) | **yes** | varies |
| `aws_waf` | partial | usually | varies |

DataDome and any non-Proxyless variant return an IP-bound cookie/token, so 2captcha must solve from your IP — pass a proxy in the `proxy` arg of `browser_solve_captcha`.

## Env

- `TWOCAPTCHA_API_KEY` (server `.env`) — enables the captcha solver tools.
- `STEALTH_BROWSER_URL` (MCP wrapper) — override the backend URL (default `http://localhost:7331`).
- `HTTP_PORT`, `WS_PORT`, `LOG_LEVEL`, `BROWSER_HEADLESS` — also overridable; see [`server/config/default.json`](./server/config/default.json) for the full schema.

## License

MIT. See [`LICENSE`](./LICENSE).
