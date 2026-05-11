import express, {Request, Response, NextFunction} from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

const PORT = 3001;
const API_KEY = 'demo-secret-key';

const app = express();
app.use(express.json());

// ── Layer 1: auth middleware ─────────────────────────────────────────────────
// Validates the Bearer token before the JSON-RPC layer ever runs.
// A bad token → HTTP 401 and the MCP server never sees the request.
app.use('/mcp', (req: Request, res: Response, next: NextFunction) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (token !== API_KEY) {
    res.status(401).json({ error: 'Unauthorized — pass Authorization: Bearer demo-secret-key' });
    return;
  }
  next();
});

// ── Layer 2: MCP server factory ──────────────────────────────────────────────
// A new McpServer instance must be created per request because the SDK only
// allows a single active transport connection per server instance.
function createMcpServer(): McpServer {
  const server = new McpServer({ name: 'demo-server', version: '1.0.0' });

  // Tool: who_made_this
  server.tool(
    'who_made_this',
    'Returns information about the creator of this project.',
    {},
    async () => ({
      content: [
        {
          type: 'text' as const,
          text: [
            'Project: mcp-learning',
            'Creator:  liguangyi',
            'Purpose:  A hands-on exploration of the Model Context Protocol (MCP) —',
            '          covering local stdio transport, remote HTTP+SSE transport,',
            '          JSON-RPC 2.0 message flow, and how to build MCP servers.',
          ].join('\n'),
        },
      ],
    }),
  );

  // Tool: greet
  server.tool(
    'greet',
    'Returns a friendly greeting addressed to the given name.',
    { name: z.string().describe('The name to greet') },
    async ({ name }) => ({
      content: [
        {
          type: 'text' as const,
          text: `Hello, ${name}! Welcome to the mcp-learning remote server demo.`,
        },
      ],
    }),
  );

  return server;
}

// ── Layer 3: route handler ───────────────────────────────────────────────────
// Each POST /mcp request gets its own server + transport instance so requests
// are handled independently (stateless per request, matching the Streamable HTTP spec).
app.post('/mcp', async (req: express.Request, res: express.Response) => {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await createMcpServer().connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.listen(PORT, () => {
  console.log(`Remote MCP server running on http://localhost:${PORT}/mcp`);
  console.log(`Auth:  Authorization: Bearer ${API_KEY}`);
  console.log('Tools: who_made_this, greet');
});
