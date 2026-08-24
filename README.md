# Canvas App MCP Relay for GPT

This project exposes Microsoft's local **Canvas Authoring MCP Server** as a remote MCP endpoint that can be hosted on Render.

## Architecture

```text
GPT / MCP client
      |
      | Streamable HTTP
      v
Render: canvas-mcp-relay
      |
      | authenticated WebSocket
      v
Your computer: local-bridge.js
      |
      | stdio
      v
Microsoft.PowerApps.CanvasAuthoring.McpServer
      |
      v
Power Apps Studio coauthoring session
```

Render cannot directly edit your Canvas App because the Microsoft Canvas Authoring MCP process and Power Apps Studio session live on your computer. The local bridge is therefore required while you are authoring.

## 1. Power Apps prerequisites

- Open the target Canvas App in Power Apps Studio.
- Enable **Settings -> Updates -> Coauthoring**.
- Keep the Studio tab open while working.
- Your Microsoft account must have edit permission to the app.

## 2. Local prerequisites

- Node.js 20+
- .NET 10 SDK
- `dnx` available from the .NET 10 SDK

Verify:

```bash
node --version
dotnet --list-sdks
dnx --help
```

The local bridge starts Microsoft's server with:

```bash
dnx Microsoft.PowerApps.CanvasAuthoring.McpServer --yes --prerelease --source https://api.nuget.org/v3/index.json
```

No custom Azure App Registration or client secret is required for the normal interactive Canvas Authoring flow.

## 3. Deploy to Render

Push this folder to GitHub, then create a Render Web Service from the repository, or use `render.yaml`.

Required Render environment variables:

```text
RELAY_TOKEN=<long-random-secret>
MCP_PUBLIC=false
BRIDGE_REQUEST_TIMEOUT_MS=120000
```

Generate a token locally, for example:

```bash
openssl rand -hex 32
```

After deployment your endpoints will look like:

```text
https://YOUR-SERVICE.onrender.com/health
https://YOUR-SERVICE.onrender.com/mcp
wss://YOUR-SERVICE.onrender.com/bridge
```

## 4. Run the local bridge

On your development machine:

```bash
npm install
CANVAS_STUDIO_URL='PASTE_THE_FULL_POWER_APPS_STUDIO_URL_HERE' \
REMOTE_URL=wss://YOUR-SERVICE.onrender.com/bridge \
RELAY_TOKEN=YOUR_RENDER_RELAY_TOKEN \
npm run bridge
```

The bridge starts the Microsoft Canvas MCP server, optionally parses `CANVAS_STUDIO_URL`, connects to that app's coauthoring session, discovers the live MCP tools, and registers them with Render. The Microsoft sign-in UI is still local to your machine.

If you prefer to connect later through GPT, omit `CANVAS_STUDIO_URL`; the proxied `connect` tool remains available.

Check:

```bash
curl -H "Authorization: Bearer YOUR_RENDER_RELAY_TOKEN" \
  https://YOUR-SERVICE.onrender.com/status
```

You should see tools such as `connect`, `sync_canvas`, `compile_canvas`, `list_controls`, and `list_data_sources`.

## 5. Connect the Canvas App

If you supplied `CANVAS_STUDIO_URL` when starting the bridge, this step is automatic. Otherwise, once GPT can see the MCP tools, call the Canvas MCP `connect` tool with values from your Power Apps Studio URL:

```text
environment_id: Default-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
app_id: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
environment_category: prod
```

The Microsoft MCP process runs locally, so interactive Microsoft/Entra authentication happens on your machine. Prefer the normal browser/broker flow.

## 6. Connect GPT

Use this MCP endpoint:

```text
https://YOUR-SERVICE.onrender.com/mcp
```

The server accepts the relay token as either:

```text
Authorization: Bearer <RELAY_TOKEN>
```

or, for clients that cannot configure an Authorization header:

```text
https://YOUR-SERVICE.onrender.com/mcp?token=<RELAY_TOKEN>
```

The query-string option is provided for compatibility but a bearer header is preferred because URLs are more likely to appear in logs/history.

## Important ChatGPT limitation

As of August 2026, full custom MCP **write/modify** actions in ChatGPT are available to Business and Enterprise/Edu workspaces. Pro supports read/fetch only. If your ChatGPT plan cannot invoke write tools, use the same Render MCP endpoint from an OpenAI API application or another full MCP client.

## Safety

- Use a DEV/copy of the Canvas App first.
- Do not set `MCP_PUBLIC=true` on an internet-facing deployment.
- Rotate `RELAY_TOKEN` if it is exposed.
- Keep one local bridge connected to one Canvas authoring process at a time.
- Keep the Power Apps Studio tab open.
- After `compile_canvas`, verify the change in Studio and re-sync before considering it persisted.

## Current Microsoft preview caveats

The Canvas Authoring MCP feature is still preview. Known issue classes reported in 2026 include:

- `compile_canvas` / `sync_canvas` sometimes reporting a successful push that did not persist canonically.
- Problems involving PCF code components and Canvas Components.
- Large screen YAML hitting a per-file compile limit.
- Intel macOS (`osx-x64`) currently lacking a supported Canvas Authoring MCP runtime package.
- Repeated Entra sign-in prompts after restarting the Microsoft MCP process.

## Troubleshooting

### `/status` says `bridgeConnected: false`

Run `npm run bridge` on your machine and make sure `REMOTE_URL` and `RELAY_TOKEN` are correct.

### `dnx` not found

Install .NET 10 SDK and restart the terminal.

### Canvas MCP starts but tools fail

Confirm:

1. Power Apps Studio is open.
2. Coauthoring is enabled.
3. The `connect` tool was called with the correct environment ID and app ID.
4. You authenticated with an account that can edit the app.

### Intel Mac

Microsoft's current preview package has an open issue for `osx-x64`. Use Apple Silicon, Windows x64/ARM64, or Linux x64/ARM64 until Microsoft ships the missing runtime.
