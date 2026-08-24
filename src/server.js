import 'dotenv/config';
import http from 'node:http';
import crypto from 'node:crypto';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import Ajv from 'ajv';

const PORT = Number(process.env.PORT || 10000);
const RELAY_TOKEN = "a54f83a70c4ef19e26c9b4c69f6a5938bf8e5046778c7e78ef14d7cb847d92ca" || '';
const MCP_PUBLIC = String(process.env.MCP_PUBLIC || 'false').toLowerCase() === 'true';
const REQUEST_TIMEOUT_MS = Number(process.env.BRIDGE_REQUEST_TIMEOUT_MS || 120000);

if (!RELAY_TOKEN) {
  console.error('RELAY_TOKEN is required for the local bridge connection.');
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: '2mb' }));

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
const ajv = new Ajv({ allErrors: true, strict: false });

let bridge = null;
let tools = [];
let validators = new Map();
const pending = new Map();

function timingSafeEqualText(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function extractToken(req) {
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
  try {
    return new URL(req.url, 'http://localhost').searchParams.get('token') || '';
  } catch {
    return '';
  }
}

function hasRelayToken(req) {
  const token = extractToken(req);
  return Boolean(token && timingSafeEqualText(token, RELAY_TOKEN));
}

function bridgeAuthMiddleware(req, res, next) {
  if (!hasRelayToken(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

function mcpAuthMiddleware(req, res, next) {
  if (MCP_PUBLIC || hasRelayToken(req)) {
    return next();
  }
  return res.status(401).json({ error: 'Unauthorized' });
}

function bridgeReady() {
  return bridge && bridge.readyState === WebSocket.OPEN;
}

function setTools(nextTools) {
  tools = Array.isArray(nextTools) ? nextTools : [];
  validators = new Map();
  for (const tool of tools) {
    try {
      if (tool?.name && tool?.inputSchema) {
        validators.set(tool.name, ajv.compile(tool.inputSchema));
      }
    } catch (error) {
      console.warn(`Could not compile schema for ${tool?.name}: ${error.message}`);
    }
  }
  console.log(`Registered ${tools.length} Canvas MCP tools from local bridge.`);
}

function rejectAllPending(message) {
  for (const [id, entry] of pending) {
    clearTimeout(entry.timer);
    entry.reject(new Error(message));
    pending.delete(id);
  }
}

function callBridge(name, args) {
  if (!bridgeReady()) {
    throw new Error('Local Canvas bridge is not connected. Start `npm run bridge` on your development machine.');
  }

  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Canvas bridge request timed out after ${REQUEST_TIMEOUT_MS} ms.`));
    }, REQUEST_TIMEOUT_MS);

    pending.set(id, { resolve, reject, timer });
    bridge.send(JSON.stringify({ type: 'call', id, name, arguments: args || {} }));
  });
}

wss.on('connection', (socket) => {
  if (bridgeReady()) {
    try { bridge.close(4001, 'A newer bridge connected'); } catch { }
  }

  bridge = socket;
  tools = [];
  validators = new Map();
  console.log('Local Canvas bridge connected.');

  socket.on('message', (buffer) => {
    let message;
    try {
      message = JSON.parse(buffer.toString());
    } catch {
      return;
    }

    if (message.type === 'hello') {
      setTools(message.tools);
      socket.send(JSON.stringify({ type: 'hello_ack' }));
      return;
    }

    if (message.type === 'result' || message.type === 'error') {
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      clearTimeout(entry.timer);

      if (message.type === 'error') {
        entry.reject(new Error(message.error || 'Unknown local bridge error'));
      } else {
        entry.resolve(message.result);
      }
    }
  });

  socket.on('close', () => {
    if (bridge === socket) {
      bridge = null;
      tools = [];
      validators = new Map();
      rejectAllPending('Local Canvas bridge disconnected.');
      console.log('Local Canvas bridge disconnected.');
    }
  });

  socket.on('error', (error) => {
    console.error('Bridge WebSocket error:', error.message);
  });
});

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname !== '/bridge') {
    socket.destroy();
    return;
  }
  if (!hasRelayToken(req)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

app.get('/', (_req, res) => {
  res.json({
    name: 'canvas-mcp-relay',
    status: 'ok',
    bridgeConnected: bridgeReady(),
    toolCount: tools.length,
    mcpEndpoint: '/mcp',
  });
});

app.get('/health', (_req, res) => {
  res.status(200).json({ ok: true, bridgeConnected: bridgeReady(), toolCount: tools.length });
});

app.get('/status', bridgeAuthMiddleware, (_req, res) => {
  res.json({ bridgeConnected: bridgeReady(), toolCount: tools.length, tools: tools.map((tool) => tool.name) });
});

app.all('/mcp', mcpAuthMiddleware, async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).set('Allow', 'POST').json({ error: 'Use POST for stateless Streamable HTTP MCP.' });
  }

  const mcp = new Server(
    { name: 'canvas-authoring-relay', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

  mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = request.params.arguments || {};
    const tool = tools.find((item) => item.name === name);

    if (!tool) {
      return {
        content: [{ type: 'text', text: `Tool '${name}' is unavailable. Ensure the local Canvas bridge is connected.` }],
        isError: true,
      };
    }

    const validate = validators.get(name);
    if (validate && !validate(args)) {
      return {
        content: [{ type: 'text', text: `Invalid arguments for '${name}': ${ajv.errorsText(validate.errors)}` }],
        isError: true,
      };
    }

    try {
      const result = await callBridge(name, args);
      return result;
    } catch (error) {
      return {
        content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
        isError: true,
      };
    }
  });

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  const originalAccept = req.headers.accept;
  if (!originalAccept || !originalAccept.includes('text/event-stream')) {
    req.headers.accept = originalAccept
      ? `${originalAccept}, text/event-stream`
      : 'application/json, text/event-stream';
  }

  try {
    await mcp.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error('MCP request failed:', error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        id: req.body?.id ?? null,
        error: { code: -32603, message: error instanceof Error ? error.message : 'Internal server error' },
      });
    }
  } finally {
    try { await transport.close(); } catch { }
    try { await mcp.close(); } catch { }
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Canvas MCP relay listening on port ${PORT}`);
});
