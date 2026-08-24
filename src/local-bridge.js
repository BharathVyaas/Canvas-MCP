import process from 'node:process';
import { WebSocket } from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const REMOTE_URL = process.env.REMOTE_URL;
const RELAY_TOKEN = process.env.RELAY_TOKEN;
const DNX_COMMAND = process.env.DNX_COMMAND || 'dnx';
const RECONNECT_MS = Number(process.env.RECONNECT_MS || 3000);
const CANVAS_STUDIO_URL = process.env.CANVAS_STUDIO_URL || '';
const CANVAS_AUTH_FLOW = process.env.CANVAS_AUTH_FLOW || '';
const CANVAS_LOGIN_HINT = process.env.CANVAS_LOGIN_HINT || '';
const CANVAS_TENANT_ID = process.env.CANVAS_TENANT_ID || '';
const CANVAS_FORCE_ACCOUNT_SELECT = String(process.env.CANVAS_FORCE_ACCOUNT_SELECT || 'false').toLowerCase() === 'true';

if (!REMOTE_URL) {
  console.error('REMOTE_URL is required, e.g. wss://your-service.onrender.com/bridge');
  process.exit(1);
}
if (!RELAY_TOKEN) {
  console.error('RELAY_TOKEN is required and must match the Render environment variable.');
  process.exit(1);
}

const canvasClient = new Client({ name: 'canvas-mcp-local-bridge', version: '1.0.0' });
const stdio = new StdioClientTransport({
  command: DNX_COMMAND,
  args: [
    'Microsoft.PowerApps.CanvasAuthoring.McpServer',
    '--yes',
    '--prerelease',
    '--source',
    'https://api.nuget.org/v3/index.json',
  ],
  stderr: 'inherit',
});

let tools = [];
let connectedToCanvas = false;
let shuttingDown = false;
let ws = null;

function parseStudioUrl(rawUrl) {
  const url = new URL(rawUrl);
  const match = url.pathname.match(/\/e\/([^/]+)/);
  if (!match) throw new Error('Could not extract environment ID from CANVAS_STUDIO_URL.');

  const appParam = url.searchParams.get('app-id');
  if (!appParam) throw new Error('Could not extract app-id from CANVAS_STUDIO_URL.');
  const decoded = decodeURIComponent(appParam);
  const appId = decoded.split('/').filter(Boolean).at(-1);
  if (!appId) throw new Error('Could not extract Canvas App ID from CANVAS_STUDIO_URL.');

  const categoryByHost = {
    'make.powerapps.com': 'prod',
    'make.preview.powerapps.com': 'prod',
    'make.preprod.powerapps.com': 'preprod',
    'make.gov.powerapps.us': 'gov',
    'make.high.powerapps.us': 'high',
    'make.apps.appsplatform.us': 'dod',
    'make.powerapps.cn': 'china',
  };

  return {
    environment_id: match[1],
    app_id: appId,
    environment_category: categoryByHost[url.hostname] || 'test',
  };
}

async function autoConnectCanvasApp() {
  if (!CANVAS_STUDIO_URL) return;

  const args = parseStudioUrl(CANVAS_STUDIO_URL);
  if (CANVAS_AUTH_FLOW) args.auth_flow = CANVAS_AUTH_FLOW;
  if (CANVAS_LOGIN_HINT) args.login_hint = CANVAS_LOGIN_HINT;
  if (CANVAS_TENANT_ID) args.tenant_id = CANVAS_TENANT_ID;
  if (CANVAS_FORCE_ACCOUNT_SELECT) args.force_account_select = true;

  console.log(`Connecting Canvas MCP to app ${args.app_id} in ${args.environment_id}...`);
  const result = await canvasClient.callTool({ name: 'connect', arguments: args });
  if (result?.isError) {
    throw new Error(`Canvas connect failed: ${JSON.stringify(result.content || result)}`);
  }
  console.log('Canvas MCP connected to the Power Apps coauthoring session.');
}

async function connectCanvas() {
  if (connectedToCanvas) return;
  console.log('Starting Microsoft Canvas Authoring MCP server...');
  await canvasClient.connect(stdio);
  const listed = await canvasClient.listTools();
  tools = listed.tools || [];
  await autoConnectCanvasApp();
  connectedToCanvas = true;
  console.log(`Canvas Authoring MCP ready with ${tools.length} tools.`);
}

function remoteWithToken() {
  const url = new URL(REMOTE_URL);
  url.searchParams.set('token', RELAY_TOKEN);
  return url;
}

async function openRelay() {
  await connectCanvas();

  return new Promise((resolve) => {
    const socket = new WebSocket(remoteWithToken());
    ws = socket;

    socket.on('open', () => {
      console.log('Connected to Render relay.');
      socket.send(JSON.stringify({ type: 'hello', tools }));
    });

    socket.on('message', async (buffer) => {
      let message;
      try {
        message = JSON.parse(buffer.toString());
      } catch {
        return;
      }

      if (message.type !== 'call') return;

      try {
        const result = await canvasClient.callTool({
          name: message.name,
          arguments: message.arguments || {},
        });
        socket.send(JSON.stringify({ type: 'result', id: message.id, result }));
      } catch (error) {
        socket.send(JSON.stringify({
          type: 'error',
          id: message.id,
          error: error instanceof Error ? error.message : String(error),
        }));
      }
    });

    socket.on('close', (code, reason) => {
      console.log(`Relay disconnected (${code}) ${reason.toString()}`);
      resolve();
    });

    socket.on('error', (error) => {
      console.error('Relay WebSocket error:', error.message);
    });
  });
}

async function run() {
  while (!shuttingDown) {
    try {
      await openRelay();
    } catch (error) {
      console.error('Bridge error:', error instanceof Error ? error.message : String(error));
    }

    if (!shuttingDown) {
      await new Promise((resolve) => setTimeout(resolve, RECONNECT_MS));
    }
  }
}

async function shutdown() {
  shuttingDown = true;
  try { ws?.close(); } catch {}
  try { await canvasClient.close(); } catch {}
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
