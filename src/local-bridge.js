import process from 'node:process';
import path from 'node:path';
import fs from 'node:fs/promises';
import { WebSocket } from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const REMOTE_URL = 'wss://canvas-mcp-q5dn.onrender.com/bridge';
const RELAY_TOKEN = 'a54f83a70c4ef19e26c9b4c69f6a5938bf8e5046778c7e78ef14d7cb847d92ca';
const DNX_COMMAND = 'dotnet';
const RECONNECT_MS = 3000;
const CANVAS_STUDIO_URL = 'https://make.powerapps.com/e/ecfe462f-6fea-e517-9265-b51708689fd0/canvas/?action=edit&connector-type=shared_sharepointonline&table-name=3011b869-44a7-4270-b02d-bd07906885d4&dataset-name=https%3A%2F%2Fpisquaretechnology.sharepoint.com%2Fsites%2FTimesheetMBLPOC&connection-name=shared-sharepointonl-ba63b691-d5c9-4473-ba99-02992833732c&template-type=MobileThreeScreen&referrer=AppsPage&app-id=%2Fproviders%2FMicrosoft.PowerApps%2Fapps%2Fd62913fb-3716-4c40-8e95-27f8dcd19660';
const CANVAS_ALLOW_WRITES = true;
const WORKSPACE_DIR = path.resolve(path.join(process.cwd(), '.canvas-mcp-workspace'));
const MAX_READ_LINES = 800;
const MAX_SEARCH_RESULTS = 300;

const canvasClient = new Client({ name: 'canvas-mcp-local-bridge', version: '1.2.0' });
const dnxPrefixArgs = path.basename(DNX_COMMAND).toLowerCase().startsWith('dotnet') ? ['dnx'] : [];

const stdio = new StdioClientTransport({
  command: DNX_COMMAND,
  args: [
    ...dnxPrefixArgs,
    'Microsoft.PowerApps.CanvasAuthoring.McpServer',
    '--yes',
    '--prerelease',
    '--source',
    'https://api.nuget.org/v3/index.json',
  ],
  stderr: 'inherit',
});

let microsoftTools = [];
let exposedTools = [];
let connectedToCanvas = false;
let shuttingDown = false;
let ws = null;

const localTools = [
  {
    name: 'canvas_connection_status',
    description: 'Verify whether the configured Power Apps Canvas coauthoring session is currently reachable. Returns the configured environment/app IDs and a live connectivity check.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'canvas_reconnect',
    description: 'Reconnect the Microsoft Canvas Authoring MCP to the bridge-configured Canvas App. This is locked to the configured app and cannot switch to another app.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'canvas_sync_workspace',
    description: 'Sync the currently connected Canvas App into the bridge-managed local workspace. Use this before reading or searching YAML so the files reflect the current app state.',
    inputSchema: {
      type: 'object',
      properties: {
        clearFirst: { type: 'boolean', description: 'Delete existing .pa.yaml files in the managed workspace before syncing. Defaults to true.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'canvas_list_files',
    description: 'List synced Canvas App .pa.yaml files in the bridge-managed workspace with size and modification time.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'canvas_read_file',
    description: 'Read exact lines from a synced Canvas App .pa.yaml file. Paths are restricted to the bridge-managed Canvas workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative .pa.yaml path returned by canvas_list_files.' },
        startLine: { type: 'integer', minimum: 1, description: '1-based first line. Defaults to 1.' },
        endLine: { type: 'integer', minimum: 1, description: '1-based inclusive last line. Limited by CANVAS_MAX_READ_LINES.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'canvas_search_yaml',
    description: 'Search the synced Canvas App YAML and return exact file/line matches. Use this to locate formulas, controls, RGBA values, Fill, FontColor, BasePaletteColor, variables, and other properties without guessing.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1 },
        isRegex: { type: 'boolean', description: 'Treat query as a JavaScript regular expression. Defaults to false.' },
        caseSensitive: { type: 'boolean', description: 'Defaults to false.' },
        maxResults: { type: 'integer', minimum: 1, maximum: 1000, description: 'Maximum matches returned.' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'canvas_inspect_theme',
    description: 'Inspect the synced YAML for exact theme/color-related values such as RGBA(), ColorValue(), Fill, Color, FontColor, BorderColor, and BasePaletteColor. Returns source file and line numbers.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

if (CANVAS_ALLOW_WRITES) {
  localTools.push(
    {
      name: 'canvas_write_file',
      description: 'Write complete content to a .pa.yaml file in the managed Canvas workspace. Requires CANVAS_ALLOW_WRITES=true on the local bridge.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['path', 'content'],
        additionalProperties: false,
      },
    },
    {
      name: 'canvas_replace_in_file',
      description: 'Safely replace exact text in a synced .pa.yaml file. Fails if the expected occurrence count does not match. Requires CANVAS_ALLOW_WRITES=true.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          oldText: { type: 'string', minLength: 1 },
          newText: { type: 'string' },
          expectedOccurrences: { type: 'integer', minimum: 1, description: 'Expected exact occurrence count. Defaults to 1.' },
        },
        required: ['path', 'oldText', 'newText'],
        additionalProperties: false,
      },
    },
    {
      name: 'canvas_compile_workspace',
      description: 'Validate and push the managed Canvas workspace through Microsoft compile_canvas. Requires CANVAS_ALLOW_WRITES=true. Read/sync again afterwards to verify the resulting live state.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
  );
}

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
  console.log(`Connecting Canvas MCP to app ${args.app_id} in ${args.environment_id}...`);
  const result = await canvasClient.callTool({ name: 'connect', arguments: args });
  if (result?.isError) {
    throw new Error(`Canvas connect failed: ${JSON.stringify(result.content || result)}`);
  }
  connectedToCanvas = true;
  console.log('Canvas MCP connected to the Power Apps coauthoring session.');
  return args;
}

async function verifyCanvasSession() {
  const configured = parseStudioUrl(CANVAS_STUDIO_URL);
  try {
    const result = await canvasClient.callTool({ name: 'list_data_sources', arguments: {} });
    if (result?.isError) {
      connectedToCanvas = false;
      return { connected: false, configured, error: result.content || result };
    }
    connectedToCanvas = true;
    return { connected: true, configured };
  } catch (error) {
    connectedToCanvas = false;
    return { connected: false, configured, error: error instanceof Error ? error.message : String(error) };
  }
}

async function ensureCanvasSession() {
  const status = await verifyCanvasSession();
  if (status.connected) return status;
  console.log('Canvas coauthoring session is unavailable; reconnecting configured app...');
  await autoConnectCanvasApp();
  const verified = await verifyCanvasSession();
  if (!verified.connected) {
    throw new Error(`Canvas MCP reconnected but the live Power Apps Studio coauthoring session is still unavailable: ${JSON.stringify(verified.error || verified)}`);
  }
  return verified;
}

function buildExposedTools() {
  const blocked = new Set(['connect', 'sync_canvas', 'compile_canvas']);
  const safeMicrosoftTools = microsoftTools.filter((tool) => !blocked.has(tool.name));
  exposedTools = [...safeMicrosoftTools, ...localTools];
}

async function connectCanvas() {
  if (connectedToCanvas) return;
  console.log('Starting Microsoft Canvas Authoring MCP server...');
  await canvasClient.connect(stdio);
  const listed = await canvasClient.listTools();
  microsoftTools = listed.tools || [];
  await autoConnectCanvasApp();
  buildExposedTools();
  connectedToCanvas = true;
  console.log(`Canvas Authoring MCP ready with ${microsoftTools.length} Microsoft tools; exposing ${exposedTools.length} safe relay tools.`);
  console.log(`Canvas workspace: ${WORKSPACE_DIR}`);
  console.log(`Canvas writes: ${CANVAS_ALLOW_WRITES ? 'ENABLED' : 'disabled (read-only)'}`);
}

function remoteWithToken() {
  const url = new URL(REMOTE_URL);
  url.searchParams.set('token', RELAY_TOKEN);
  return url;
}

function safeWorkspacePath(relativePath) {
  if (!relativePath || path.isAbsolute(relativePath)) {
    throw new Error('A relative workspace path is required.');
  }
  const resolved = path.resolve(WORKSPACE_DIR, relativePath);
  const prefix = `${WORKSPACE_DIR}${path.sep}`;
  if (resolved !== WORKSPACE_DIR && !resolved.startsWith(prefix)) {
    throw new Error('Path escapes the managed Canvas workspace.');
  }
  if (!resolved.endsWith('.pa.yaml')) {
    throw new Error('Only .pa.yaml files are allowed.');
  }
  return resolved;
}

async function listYamlFiles(dir = WORKSPACE_DIR, base = WORKSPACE_DIR) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }

  const out = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...await listYamlFiles(full, base));
    } else if (entry.isFile() && entry.name.endsWith('.pa.yaml')) {
      const stat = await fs.stat(full);
      out.push({
        path: path.relative(base, full).split(path.sep).join('/'),
        size: stat.size,
        modifiedAt: stat.mtime.toISOString(),
      });
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

async function clearYamlFiles(dir = WORKSPACE_DIR) {
  const files = await listYamlFiles(dir, dir);
  for (const file of files) {
    await fs.rm(path.join(dir, file.path), { force: true });
  }
}

function directoryArgumentsFor(toolName) {
  const tool = microsoftTools.find((item) => item.name === toolName);
  if (!tool) throw new Error(`Microsoft Canvas tool '${toolName}' is unavailable.`);
  const properties = tool.inputSchema?.properties || {};
  const keys = Object.keys(properties);

  const preferred = [
    'directory', 'directoryPath', 'directory_path', 'workingDirectory', 'working_directory',
    'workspace', 'workspacePath', 'workspace_path', 'path', 'folder', 'folderPath', 'folder_path',
  ];

  let key = preferred.find((candidate) => keys.includes(candidate));
  if (!key) {
    key = keys.find((candidate) => {
      const schema = properties[candidate] || {};
      return schema.type === 'string' && /(dir|directory|path|folder|workspace)/i.test(candidate);
    });
  }
  if (!key && keys.length === 1 && properties[keys[0]]?.type === 'string') {
    key = keys[0];
  }
  if (!key) {
    throw new Error(`Could not determine working-directory argument for '${toolName}'. Tool schema: ${JSON.stringify(tool.inputSchema)}`);
  }
  return { [key]: WORKSPACE_DIR };
}

async function callMicrosoftDirectoryTool(toolName) {
  await ensureCanvasSession();
  await fs.mkdir(WORKSPACE_DIR, { recursive: true });
  const args = directoryArgumentsFor(toolName);
  return canvasClient.callTool({ name: toolName, arguments: args });
}

function textResult(value, isError = false) {
  return {
    content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

async function handleLocalTool(name, args = {}) {
  if (name === 'canvas_connection_status') {
    return textResult(await verifyCanvasSession());
  }

  if (name === 'canvas_reconnect') {
    await autoConnectCanvasApp();
    const status = await verifyCanvasSession();
    if (!status.connected) return textResult(status, true);
    return textResult(status);
  }

  if (name === 'canvas_sync_workspace') {
    await fs.mkdir(WORKSPACE_DIR, { recursive: true });
    if (args.clearFirst !== false) await clearYamlFiles();
    const syncResult = await callMicrosoftDirectoryTool('sync_canvas');
    if (syncResult?.isError) return syncResult;
    const files = await listYamlFiles();
    return textResult({ workspace: WORKSPACE_DIR, files, syncResult });
  }

  if (name === 'canvas_list_files') {
    return textResult({ workspace: WORKSPACE_DIR, files: await listYamlFiles() });
  }

  if (name === 'canvas_read_file') {
    const full = safeWorkspacePath(args.path);
    const raw = await fs.readFile(full, 'utf8');
    const lines = raw.split(/\r?\n/);
    const start = Math.max(1, Number(args.startLine || 1));
    const requestedEnd = Number(args.endLine || Math.min(lines.length, start + MAX_READ_LINES - 1));
    const end = Math.min(lines.length, requestedEnd, start + MAX_READ_LINES - 1);
    if (end < start) throw new Error('endLine must be greater than or equal to startLine.');
    const content = lines.slice(start - 1, end).map((line, index) => `${start + index}: ${line}`).join('\n');
    return textResult({ path: args.path, startLine: start, endLine: end, totalLines: lines.length, content });
  }

  if (name === 'canvas_search_yaml') {
    const files = await listYamlFiles();
    const maxResults = Math.min(Number(args.maxResults || MAX_SEARCH_RESULTS), 1000);
    const flags = args.caseSensitive ? 'g' : 'gi';
    let regex;
    if (args.isRegex) regex = new RegExp(args.query, flags);
    const needle = args.caseSensitive ? args.query : args.query.toLowerCase();
    const matches = [];

    for (const file of files) {
      const raw = await fs.readFile(safeWorkspacePath(file.path), 'utf8');
      const lines = raw.split(/\r?\n/);
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        let matched = false;
        if (regex) {
          regex.lastIndex = 0;
          matched = regex.test(line);
        } else {
          matched = (args.caseSensitive ? line : line.toLowerCase()).includes(needle);
        }
        if (matched) matches.push({ path: file.path, line: i + 1, text: line });
        if (matches.length >= maxResults) break;
      }
      if (matches.length >= maxResults) break;
    }
    return textResult({ query: args.query, count: matches.length, truncated: matches.length >= maxResults, matches });
  }

  if (name === 'canvas_inspect_theme') {
    const files = await listYamlFiles();
    const colorRegex = /(RGBA\s*\([^)]*\)|ColorValue\s*\([^)]*\)|\b(?:Fill|Color|FontColor|BorderColor|BasePaletteColor|HoverFill|PressedFill|DisabledFill|HoverColor|PressedColor|DisabledColor)\s*:.*)/i;
    const matches = [];
    const uniqueValues = new Set();

    for (const file of files) {
      const raw = await fs.readFile(safeWorkspacePath(file.path), 'utf8');
      const lines = raw.split(/\r?\n/);
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        if (!colorRegex.test(line)) continue;
        matches.push({ path: file.path, line: i + 1, text: line });
        for (const hit of line.matchAll(/RGBA\s*\([^)]*\)|ColorValue\s*\([^)]*\)/gi)) uniqueValues.add(hit[0]);
        if (matches.length >= 600) break;
      }
      if (matches.length >= 600) break;
    }
    return textResult({ uniqueColorExpressions: [...uniqueValues].sort(), count: matches.length, matches });
  }

  if (name === 'canvas_write_file') {
    if (!CANVAS_ALLOW_WRITES) throw new Error('Canvas writes are disabled. Set CANVAS_ALLOW_WRITES=true on the local bridge.');
    const full = safeWorkspacePath(args.path);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, args.content, 'utf8');
    return textResult({ written: args.path, bytes: Buffer.byteLength(args.content, 'utf8') });
  }

  if (name === 'canvas_replace_in_file') {
    if (!CANVAS_ALLOW_WRITES) throw new Error('Canvas writes are disabled. Set CANVAS_ALLOW_WRITES=true on the local bridge.');
    const full = safeWorkspacePath(args.path);
    const raw = await fs.readFile(full, 'utf8');
    const expected = Number(args.expectedOccurrences || 1);
    const occurrences = raw.split(args.oldText).length - 1;
    if (occurrences !== expected) {
      throw new Error(`Expected ${expected} occurrence(s) of oldText in ${args.path}, found ${occurrences}. No changes written.`);
    }
    const updated = raw.split(args.oldText).join(args.newText);
    await fs.writeFile(full, updated, 'utf8');
    return textResult({ path: args.path, replacedOccurrences: occurrences });
  }

  if (name === 'canvas_compile_workspace') {
    if (!CANVAS_ALLOW_WRITES) throw new Error('Canvas writes are disabled. Set CANVAS_ALLOW_WRITES=true on the local bridge.');
    return callMicrosoftDirectoryTool('compile_canvas');
  }

  throw new Error(`Unknown local bridge tool '${name}'.`);
}

async function handleCall(name, args) {
  if (localTools.some((tool) => tool.name === name)) {
    return handleLocalTool(name, args);
  }

  if (name === 'connect' || name === 'sync_canvas' || name === 'compile_canvas') {
    throw new Error(`Direct '${name}' access is disabled by the relay. Use the managed canvas_* workspace tools instead.`);
  }

  const tool = microsoftTools.find((item) => item.name === name);
  if (!tool) throw new Error(`Tool '${name}' is unavailable.`);
  await ensureCanvasSession();
  return canvasClient.callTool({ name, arguments: args || {} });
}

async function openRelay() {
  await connectCanvas();

  return new Promise((resolve) => {
    const socket = new WebSocket(remoteWithToken());
    ws = socket;

    socket.on('open', () => {
      console.log('Connected to Render relay.');
      socket.send(JSON.stringify({ type: 'hello', tools: exposedTools }));
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
        const result = await handleCall(message.name, message.arguments || {});
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
  try { ws?.close(); } catch { }
  try { await canvasClient.close(); } catch { }
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
