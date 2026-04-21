# stealth-browser

Playwright-based stealth browser automation with an MCP wrapper for Claude Code.

Two pieces that work together:

| Package | Role |
|---|---|
| [`server/`](./server) | HTTP+WebSocket server on `localhost:7331` that drives a persistent stealth Chrome via Playwright. Stealth plugins (fingerprint randomization, WebGL spoofing, UA rotation), human-behavior automation (typing/click jitter), session persistence, attach mode. |
| [`mcp/`](./mcp) | Thin MCP (Model Context Protocol) server that exposes the HTTP API as structured tool calls so Claude Code can drive the browser over stdio. |

## Architecture

```
Claude Code  <--stdio-->  mcp/index.js  <--HTTP-->  server (localhost:7331)  <--CDP-->  Chrome
```

## Quick start

**1. Install + start the server:**

```bash
cd server
npm install
npm run build
# then either:
xvfb-run -a node dist/index.js      # headful under xvfb (recommended for stealth)
# or for a regular desktop session:
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

## Env

- `STEALTH_BROWSER_URL` (MCP wrapper) — override the backend URL (default `http://localhost:7331`).

## License

MIT. See [`LICENSE`](./LICENSE).
