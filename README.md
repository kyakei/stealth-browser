# stealth-browser

Playwright-based stealth browser automation with an MCP wrapper for Claude Code.

Drives a single, persistent, human-visible Chrome the way an AI agent actually wants to drive a browser: navigate it, type into it, scrape network traffic from it, hijack WebSockets, intercept requests Burp-style, snapshot/diff cookie jars, solve captchas, bulk-replay authed HTTP, crawl JS-rendered routes — all over a structured tool surface, while keeping the same window open so the human can step in for MFA or manual fixes mid-session.

## Highlights

- **Persistent attached Chrome** — driven via CDP. The window stays open across calls; the AI and the human share one tab, one cookie jar, one session. Survives server/Claude-Code restarts.
- **Hardened stealth** — `playwright-extra` + `puppeteer-extra-plugin-stealth` *plus* ~72 tuned Chrome launch flags (ported from [Scrapling](https://github.com/D4Vinci/Scrapling)): `--disable-blink-features=AutomationControlled`, desktop hover/pointer-type spoofing (`matchMedia('(hover:hover)')`→true, so headless-detection fails), `--enable-automation` stripped, dark `colorScheme` emulation, killed background networking/throttling/breakpad. Launched headful under `xvfb`.
- **`browser_chain`** — run a whole step sequence (navigate→wait→type→type→click→wait→read…) server-side in one call. Collapses ~10 MCP round-trips into 1 — the difference between "feels sluggish" and "feels instant" on multi-step flows.
- **`browser_replay_http`** — "browser for auth, fast HTTP for bulk": log in once with the visible Chrome, then fire N requests (IDOR/BOLA enumeration via `idRange`/`urls` templates) without a page-load each. Same-origin → in-page `fetch()` (real Chrome TLS, parallel pool); cross-origin → server-side with context cookies.
- **Captcha solver (2captcha)** — auto-detect + auto-solve reCAPTCHA v2/v3 (incl. **Enterprise** + `recaptcha.net`-hosted), hCaptcha, Cloudflare Turnstile, **FunCaptcha/Arkose**, DataDome, MTCaptcha, Friendly Captcha, AWS WAF. ~$0.003 + ~10s for reCAPTCHA v2.
- **Free Cloudflare interstitial bypass** — `browser_solve_cloudflare` detects + clears the "Just a moment…" / managed-Turnstile wall by coordinate-clicking the checkbox iframe (no 2captcha; falls back to the paid solver only if CF escalates to a hard puzzle).
- **Burp-style request/response intercept** — pause, mutate, drop, or forward live HTTP traffic from the tool surface.
- **WebSocket capture + injection** — list every WS the page opened, read every frame in/out, inject your own frames on any open connection.
- **HAR export with response bodies** — drop the captured network log straight into Burp / HTTP Toolkit / DevTools.
- **Cookie tooling** — list (incl. HttpOnly), delete (guarded), snapshot, diff, JSON/env-format file load+export. Multiple named contexts for parallel cookie jars (user-A vs. user-B for IDOR).
- **Page recon** — `browser_find_similar` (give one element, get all structurally-alike ones), `browser_crawl` (in-browser BFS — renders JS, catches SPA routes a passive crawler misses), `browser_extract_tokens` (scans for `xox*` Slack tokens + `boot_data.api_token`).
- **Speed** — `browser_block_resources` aborts noisy resource types and/or ~120 ad/analytics/tracker domains: heavy enterprise page ~8s→2s, and the network capture stops being mostly beacons.

~55 MCP tools total. See [`mcp/index.js`](./mcp/index.js) for the full list.

## Architecture

```
Claude Code  <—stdio—>  mcp/index.js  <—HTTP—>  server (localhost:7331)  <—CDP—>  Chrome (Xvfb)
```

| Package | Role |
|---|---|
| [`server/`](./server) | Express HTTP+WebSocket server on `:7331`/`:7332`. Owns the persistent stealth Chrome, the CDP session, the network/WS log, named cookie contexts, intercept rules, the captcha & Cloudflare solvers, the chain runner, the HTTP-replay engine, the crawler. |
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

The server loads `.env` via dotenv on startup. `.env` is gitignored. (The Cloudflare interstitial solver works *without* a 2captcha key.)

## Tool surface (overview)

| Category | Tools |
|---|---|
| Lifecycle | `browser_health`, `browser_attach`, `browser_detach`, `browser_attach_status` |
| Navigation | `browser_navigate`, `browser_wait_for`, `browser_list_tabs`, `browser_select_tab` |
| Page read | `browser_page_text`, `browser_form_snapshot`, `browser_eval_js`, `browser_dom_snapshot`, `browser_screenshot` |
| Page interact | `browser_click_text`, `browser_click_selector`, `browser_type`, `browser_keyboard_type` |
| **Chain** | `browser_chain` — run a step sequence server-side in one call |
| **HTTP replay** | `browser_replay_http` — bulk authed requests (IDOR enum) |
| Network | `browser_network_query`, `browser_network_entry`, `browser_network_clear`, `browser_har_export` |
| WebSocket | `browser_ws_list`, `browser_ws_detail`, `browser_ws_frames`, `browser_ws_send` |
| Cookies | `browser_cookies_get_attached`, `browser_cookies_delete`, `browser_cookies_snapshot`, `browser_cookies_diff`, `browser_cookies_load_file`, `browser_cookies_export_file` |
| Multi-context | `browser_contexts_list`, `browser_context_create`, `browser_context_close`, `browser_context_navigate`, `browser_context_cookies` |
| Intercept (Burp) | `browser_intercept_enable`, `browser_intercept_status`, `browser_intercept_forward`, `browser_intercept_drop`, `browser_intercept_disable` |
| Captcha | `browser_captcha_balance`, `browser_captcha_detect`, `browser_solve_captcha` |
| Cloudflare | `browser_cloudflare_detect`, `browser_solve_cloudflare` (free — no 2captcha) |
| Page recon | `browser_find_similar`, `browser_crawl`, `browser_extract_tokens` |
| Speed | `browser_block_resources` (resource-type + ad/tracker domain blocking) |

## Captcha solver — supported types

| Type | Auto-detect | Proxy required | Cost (typical) |
|---|---|---|---|
| `recaptcha_v2` (checkbox) | ✓ | no | $0.003 |
| `recaptcha_v2_invisible` | ✓ | no | $0.003 |
| `recaptcha_v3` | ✓ (sitekey + script) | no | $0.003 |
| `hcaptcha` / `hcaptcha_invisible` | ✓ | no | $0.003 |
| `turnstile` (Cloudflare) | ✓ | no | $0.003 |
| `funcaptcha` (Arkose Labs) | ✓ (`data-pkey` / arkoselabs iframe) | no | ~$0.005 |
| `mtcaptcha` | ✓ | no | low |
| `friendly` | ✓ | no | low |
| `datadome` | ✓ (iframe URL) | **yes** | varies |
| `aws_waf` | partial | usually | varies |

- **Enterprise reCAPTCHA** is auto-detected (the detector spots `/enterprise/` in the anchor iframe and flags `enterprise:true`) and routed to the correct `RecaptchaV2EnterpriseTaskProxyless` task type — not the regular task with an `isEnterprise` flag, which 2captcha rejects.
- **`recaptcha.net`-hosted** widgets are auto-detected and `apiDomain:"recaptcha.net"` is passed to 2captcha so the verify call hits the right host.
- DataDome and any non-Proxyless variant return an IP-bound cookie/token, so 2captcha must solve from your IP — pass a proxy in the `proxy` arg of `browser_solve_captcha`.
- For a Cloudflare *interstitial* (the full-page "checking your browser" wall), prefer `browser_solve_cloudflare` — it's free and usually ~3s. Only escalate to `browser_solve_captcha type:"turnstile"` if CF presents a hard interactive puzzle.

## Env

- `TWOCAPTCHA_API_KEY` (server `.env`) — enables the 2captcha-backed solver tools. (`browser_solve_cloudflare` works without it.)
- `STEALTH_BROWSER_URL` (MCP wrapper) — override the backend URL (default `http://localhost:7331`).
- `STEALTH_BROWSER_TIMEOUT_MS` (MCP wrapper) — per-request timeout in ms (default `240000`; bumped from 60s so Enterprise reCAPTCHA / Arkose solves don't get cut off).
- `HTTP_PORT`, `WS_PORT`, `LOG_LEVEL`, `BROWSER_HEADLESS` — also overridable; see [`server/config/default.json`](./server/config/default.json) for the full schema.

## License

MIT. See [`LICENSE`](./LICENSE).
