# Bug: "Already connected to a transport" on second MCP request

## Symptom

The server starts successfully, but crashes on the second (or any subsequent) `POST /mcp` request with:

```
Remote MCP server running on http://localhost:3001/mcp
Auth:  Authorization: Bearer demo-secret-key
Tools: who_made_this, greet
file:///[project-root]/remote-mcp-server-demo/node_modules/@modelcontextprotocol/sdk/dist/esm/shared/protocol.js:217
            throw new Error('Already connected to a transport. Call close() before connecting to a new transport, or use a separate Protocol instance per connection.');
                  ^

Error: Already connected to a transport. Call close() before connecting to a new transport, or use a separate Protocol instance per connection.
    at Server.connect ([project-root]/remote-mcp-server-demo/node_modules/@modelcontextprotocol/sdk/src/shared/protocol.ts:609:19)
    at McpServer.connect ([project-root]/remote-mcp-server-demo/node_modules/@modelcontextprotocol/sdk/src/server/mcp.ts:112:34)
    at <anonymous> ([project-root]/remote-mcp-server-demo/index.ts:70:19)
    at Layer.handle [as handle_request] ([project-root]/remote-mcp-server-demo/node_modules/express/lib/router/layer.js:95:5)
    at next ([project-root]/remote-mcp-server-demo/node_modules/express/lib/router/route.js:149:13)
    at Route.dispatch ([project-root]/remote-mcp-server-demo/node_modules/express/lib/router/route.js:119:3)
    at Layer.handle [as handle_request] ([project-root]/remote-mcp-server-demo/node_modules/express/lib/router/layer.js:95:5)
    at [project-root]/remote-mcp-server-demo/node_modules/express/lib/router/index.js:284:15
    at Function.process_params ([project-root]/remote-mcp-server-demo/node_modules/express/lib/router/index.js:346:12)
    at next ([project-root]/remote-mcp-server-demo/node_modules/express/lib/router/index.js:280:10)

Node.js v20.16.0
```

## Root Cause

The original code created a single `McpServer` instance at module level and reused it for every request:

```ts
const mcpServer = new McpServer({ name: 'demo-server', version: '1.0.0' });
// tools registered once on this instance...

app.post('/mcp', async (req, res) => {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await mcpServer.connect(transport); // ← crashes on 2nd request
  await transport.handleRequest(req, res, req.body);
});
```

`McpServer` extends the SDK's `Protocol` class, which stores the active transport as internal state. Once `connect()` is called the first time, calling it again — even with a different transport — throws the error above.

## Fix

Extract a factory function that creates a **fresh `McpServer`** (with tools registered on it) for every incoming request:

```ts
function createMcpServer(): McpServer {
  const server = new McpServer({ name: 'demo-server', version: '1.0.0' });
  server.tool('who_made_this', ...);
  server.tool('greet', ...);
  return server;
}

app.post('/mcp', async (req, res) => {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await createMcpServer().connect(transport); // fresh instance each time
  await transport.handleRequest(req, res, req.body);
});
```

Each request now gets its own isolated server + transport pair, which matches the stateless-per-request model the Streamable HTTP transport is designed for.
