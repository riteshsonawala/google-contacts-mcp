# google-contacts-mcp

A self-contained, zero-dependency Node.js / TypeScript MCP (Model Context Protocol) server (`google-contacts-mcp.mjs`) that connects **Claude**, **ChatGPT**, and **Gemini** to **Google Contacts** (Google People API v1).

Add, edit, merge, search, and organize Google Contacts from **PNG / JPG images** (business cards, screenshots, badges), **markup** (HTML signatures, Markdown, vCard `.vcf`, CSV, JSON), or **freeform text**.

- **Single self-contained `.mjs` file**: Run `node google-contacts-mcp.mjs` directly on Node.js ≥ 20 — **no `npm install` or `node_modules` required**.
- **TypeScript source included**: Full TypeScript source lives in `src/google-contacts-mcp.ts` and compiles cleanly to `google-contacts-mcp.mjs` via Node's built-in type stripper (`npm run build`).
- **Dual transport**: Speaks **stdio** by default (Claude Desktop, Claude Code, Gemini CLI, ChatGPT Desktop) and **Streamable HTTP / SSE** (`--http`) for remote/connector harnesses.

---

## Tools Exposed

| Tool | Purpose |
|---|---|
| `upsert_contact` | **Smart Add-or-Edit**: Searches by email → phone → full name. Updates & merges if found; creates a new contact if not. |
| `create_contact` | Create a new contact with full details (names, emails, phones, company, title, addresses, URLs, birthday, notes, custom fields, avatar photo). |
| `update_contact` | Edit an existing contact by `resourceName` (`people/c...`). Automatically fetches `etag` and safely merges or replaces fields. |
| `parse_and_upsert_contact` | Parse raw **vCard (`.vcf`)**, **HTML**, **Markdown**, **CSV**, **JSON**, or **freeform email signatures** and upsert into Google Contacts (`dryRun` supported). |
| `extract_contact_from_image` | Extract contact details from **PNG / JPG / WEBP / GIF** (local file path, `file://` URL, `data:` URI, or base64) via MCP Sampling, Vision API, or native MCP `ImageContent` harness pass-through. |
| `search_contacts` | Full-text search across names, emails, phone numbers, organizations, and notes. |
| `get_contact` | Fetch complete details for a contact by `resourceName`. |
| `list_contacts` | Paginated contact listing with configurable sort order. |
| `delete_contact` | Delete a contact by `resourceName`. |
| `manage_contact_groups` | List, create, or add/remove contacts from Google Contact labels/groups (`contactGroups`). |

---

## How Multi-Format Inputs Work (PNG, JPG, Text, Markup)

1. **Images (`PNG`, `JPG`, `WEBP`, `GIF`)**:
   - **Attached directly in Claude / ChatGPT / Gemini chat**: The harness's multimodal vision reads the business card or screenshot directly and calls `upsert_contact` (and can optionally pass `photoBase64` / `photoPath` to set the contact's avatar).
   - **Local file path or Base64 passed to `extract_contact_from_image`**:
     1. Uses **MCP Sampling (`sampling/createMessage`)** if supported by the connected client.
     2. Or uses a server-side Vision API if `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, or `OPENAI_API_KEY` is set.
     3. Otherwise returns a native MCP `ImageContent` block (`{ type: "image", data, mimeType }`) so Claude, ChatGPT, or Gemini visually inspects the image and calls `upsert_contact`.
2. **Text & Markup (`vCard`, `HTML`, `Markdown`, `CSV`, `JSON`, `Text`)**:
   - Call `parse_and_upsert_contact` with raw content (or let the LLM extract fields and call `upsert_contact`).
   - Built-in parsers extract `mailto:` / `tel:` links, hCard microformats (`p-name`, `p-org`, `p-job-title`), vCard 2.1/3.0/4.0 properties, Markdown tables/links, CSV rows, and natural-language signatures.

---

## Quick Start (Browser Mode — Zero Client ID or Secret Needed!)

By default, `google-contacts-mcp` runs as a **100% local `stdio` MCP server** that automates **`https://contacts.google.com`** directly in your local browser (using **Playwright** if installed, or built-in zero-dependency **Chrome DevTools Protocol** with your local Google Chrome / Brave / Edge).

- **No Google Cloud project, no OAuth Client ID, and no Client Secret required.**
- When you use a tool for the first time (or run `node google-contacts-mcp.mjs --auth`), it **launches Chrome to `https://contacts.google.com`**:
  1. If you aren't logged in yet, simply sign in to your Google account in the browser window.
  2. Your session is saved in a dedicated persistent browser profile at `~/.config/google-contacts-mcp/chrome-profile` so you stay logged in across restarts.
  3. All contact creations, edits, merges, and searches happen directly on `contacts.google.com`.

You can trigger the initial browser login at any time with:

```bash
node /Users/ritesh/Projects/google-contacts-mcp/google-contacts-mcp.mjs --auth
```

Verify local browser profile & login status:

```bash
node /Users/ritesh/Projects/google-contacts-mcp/google-contacts-mcp.mjs --status
```

> **Optional People API Mode**: If you ever want headless REST API mode instead of browser automation, set `GOOGLE_CONTACTS_BACKEND=api`.

---

## Wiring Clients (Claude, ChatGPT, Gemini) — Zero Env Vars Needed

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "google-contacts": {
      "command": "node",
      "args": ["/Users/ritesh/Projects/google-contacts-mcp/google-contacts-mcp.mjs"]
    }
  }
}
```

### Claude Code

```bash
claude mcp add google-contacts \
  --scope user \
  -- node /Users/ritesh/Projects/google-contacts-mcp/google-contacts-mcp.mjs
```

### Gemini CLI & Gemini Code Assist

Add to `~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "google-contacts": {
      "command": "node",
      "args": ["/Users/ritesh/Projects/google-contacts-mcp/google-contacts-mcp.mjs"]
    }
  }
}
```

### ChatGPT (Desktop MCP or Streamable HTTP / SSE Connector)

- **Stdio mode** (local MCP runner / Desktop):
  Point the command to `node /Users/ritesh/Projects/google-contacts-mcp/google-contacts-mcp.mjs`.
- **Streamable HTTP / SSE mode** (for ChatGPT Developer Mode / HTTP connectors):
  ```bash
  node /Users/ritesh/Projects/google-contacts-mcp/google-contacts-mcp.mjs --http --port 3000
  ```
  Endpoints exposed:
  - `POST http://127.0.0.1:3000/mcp` (Streamable HTTP JSON-RPC)
  - `GET  http://127.0.0.1:3000/sse` + `POST /messages` (SSE transport)
  - `GET  http://127.0.0.1:3000/health` (Health check)

---

## Development & Testing

```bash
# Rebuild standalone google-contacts-mcp.mjs from src/google-contacts-mcp.ts
npm run build

# Run unit & integration test suite (zero external dependencies)
npm test
```

## Project Layout

```text
google-contacts-mcp/
├── google-contacts-mcp.mjs       # Standalone, zero-dependency executable MCP server
├── src/
│   └── google-contacts-mcp.ts    # Full TypeScript source
├── scripts/
│   └── build.mjs                 # Zero-dep builder using Node's stripTypeScriptTypes
├── test/
│   └── google-contacts-mcp.test.mjs
├── .env.example
├── package.json
├── tsconfig.json
└── README.md
```

## License

MIT
