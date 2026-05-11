# How Remote MCP Communication Works

## 1. Same JSON-RPC, different transport

Local and remote MCP use the exact same JSON-RPC 2.0 message format. What changes is only the **transport layer** underneath.

| | local (stdio) | remote (HTTP) |
|---|---|---|
| Message format | JSON-RPC 2.0 | JSON-RPC 2.0 |
| Transport | stdin/stdout pipe | HTTPS |
| How messages travel | bytes through a pipe | HTTP POST requests + optional SSE stream |
| Auth | none (OS trust) | `Authorization` header |
| Server location | child process on same machine | somewhere on the internet |

---

## 2. How HTTP carries JSON-RPC messages

With stdio, sending a message is just writing a line to a pipe. With HTTP it works like this:

**Sending a request** — HTTP POST:
```
POST https://api.githubcopilot.com/mcp/ HTTP/1.1
Authorization: Bearer ghp_xxx
Content-Type: application/json

{ "jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {} }
```

**Receiving responses** — depends on what the server needs to send back:

Simple response (no streaming needed):
```
HTTP/1.1 200 OK
Content-Type: application/json

{ "jsonrpc": "2.0", "id": 1, "result": { "tools": [...] } }
```

Multiple events (server uses SSE to stream them):
```
HTTP/1.1 200 OK
Content-Type: text/event-stream

data: { "jsonrpc": "2.0", "id": 1, "result": { "tools": [...] } }

data: { "jsonrpc": "2.0", "id": 2, "result": { "content": "..." } }
```

---

## 3. Full picture side by side

```
LOCAL                                    REMOTE

your code                                your code
   │                                        │
   │  JSON-RPC over stdin/stdout            │  JSON-RPC over HTTPS (+ SSE when needed)
   ▼                                        ▼
filesystem server                        api.githubcopilot.com
(child process, same machine)            (GitHub's servers, internet)
   │                                        │
   │  reads local files                     │  calls GitHub REST API
   ▼                                        ▼
your disk                                github.com
```

The JSON-RPC messages (`initialize`, `tools/list`, `tools/call`) are identical in both cases. The only difference is the pipe they travel through.

---

## 4. What is SSE and is it required?

**SSE (Server-Sent Events)** is a one-way stream from server to client over a regular HTTP connection that stays open.

### Is SSE required?

It depends on which version of the MCP transport spec is being used:

| MCP transport | SSE required? |
|---|---|
| Original HTTP transport (2024) | Yes — always |
| Streamable HTTP transport (2025) | No — optional |

Our GitHub demo uses the **Streamable HTTP transport** (that is why the type in the package is called `StreamableHTTPClientTransportOptions`). In this newer spec, the server decides whether to use SSE based on what it needs to send back:

| situation | server response |
|---|---|
| Single result (e.g. `tools/list`) | plain HTTP response, connection closes |
| Multiple events (e.g. progress during a long tool call) | SSE stream |

A simple request/response with no SSE:
```
client → POST /mcp/  { method: "tools/list" }
server ← HTTP 200    { result: { tools: [...] } }
connection closes
```

SSE only kicks in when the server has a reason to push multiple messages back. Normal HTTP is strictly request → response, one at a time — SSE keeps the connection open so the server can stream:

```
client → POST (one request)
client ← response starts streaming...
client ← data: message 1
client ← data: message 2
client ← data: message 3
         (connection stays open until done)
```

---

## 5. What SSE looks like on the wire

SSE is plain text over HTTP with a specific format — each event is prefixed with `data:` and separated by a blank line:

```
HTTP/1.1 200 OK
Content-Type: text/event-stream
Cache-Control: no-cache

data: {"jsonrpc":"2.0","id":1,"result":{"tools":[...]}}

data: {"jsonrpc":"2.0","id":2,"result":{"content":"..."}}

data: {"jsonrpc":"2.0","method":"notifications/progress","params":{...}}

```

Each `data:` line is one JSON-RPC message. The blank line between them signals "this event is complete, next one starts."

---

## 6. Full HTTP + SSE flow for MCP

```
your code                        api.githubcopilot.com
   │                                      │
   │  POST /mcp/                          │
   │  { method: "initialize" }  ────────► │
   │                                      │
   │  ◄──── HTTP 200, stream opens ─────  │
   │  ◄──── data: { result: {             │
   │          capabilities: {} } }        │
   │                                      │
   │  POST /mcp/                          │
   │  { method: "tools/list" }  ────────► │
   │  ◄──── data: { result: {             │
   │          tools: [...] } }            │
   │                                      │
   │  POST /mcp/                          │
   │  { method: "tools/call",             │
   │    params: { name:                   │
   │    "get_file_contents" } } ────────► │
   │  ◄──── data: { result: {             │
   │          content: "..." } }          │
```

Each POST carries one JSON-RPC request. The SSE stream on each response carries the reply back.

---

## 7. SSE vs WebSocket — why not WebSocket?

| | SSE | WebSocket |
|---|---|---|
| Direction | server → client only | both directions |
| Protocol | plain HTTP | upgraded connection (`ws://`) |
| Simplicity | very simple | more complex handshake |
| Firewall friendly | yes (it's just HTTP) | sometimes blocked |

MCP chose SSE (when streaming is needed) because the client already sends requests via HTTP POST — it only needs the server to stream responses back. That is exactly what SSE is designed for. No need for the complexity of WebSocket.

---

## 8. Authentication and Authorization

Auth works at the **HTTP layer** — the same way any secured HTTP API works. The JSON-RPC payload itself carries no credentials.

---

### The basic flow — every request carries the token

```
your code                        api.githubcopilot.com
   │                                      │
   │  POST /mcp/                          │
   │  Authorization: Bearer ghp_xxx       │
   │  { method: "initialize" }  ────────► │
   │                                      │  1. validate token first
   │                                      │  2. if invalid → 401, stop
   │                                      │  3. if valid → run JSON-RPC
   │  ◄──── { result: {...} } ───────────  │
   │                                      │
   │  POST /mcp/                          │
   │  Authorization: Bearer ghp_xxx       │  same token on every request
   │  { method: "tools/list" }  ────────► │
   │  ◄──── { result: {...} } ───────────  │
```

The server validates the token **before** touching the JSON-RPC message. If the token is bad, it returns HTTP 401 and the JSON-RPC layer never runs.

---

### The MCP 2025 spec — OAuth 2.0 flow

For production remote MCP servers, the spec standardizes OAuth 2.0. Instead of a static token in `.env`, the client goes through a proper auth flow to get a short-lived token:

```
your code                        MCP server
   │                                  │
   │  POST /mcp/  (no token yet)      │
   │ ────────────────────────────────►│
   │  ◄──── 401 Unauthorized ─────── │
   │         WWW-Authenticate:        │
   │         resource_metadata url    │
   │                                  │
   │  GET /.well-known/               │
   │      oauth-protected-resource    │
   │ ────────────────────────────────►│
   │  ◄──── { authorization_servers: │
   │          ["https://..."] }        │
   │                                  │
   │  (OAuth login flow with user)    │
   │  → get short-lived access token  │
   │                                  │
   │  POST /mcp/                      │
   │  Authorization: Bearer <token>   │
   │ ────────────────────────────────►│
   │  ◄──── { result: {...} } ─────── │
```

---

### What our demo does instead

Our demo skips the OAuth flow and uses a PAT (Personal Access Token) directly — a static long-lived token stored in `.env`:

```ts
requestInit: {
  headers: {
    Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
  },
},
```

This is simpler for development but less secure for production:

| | PAT (what we use) | OAuth token (spec recommends) |
|---|---|---|
| Lifetime | months / never expires | short-lived (hours) |
| Scope | fixed when created | requested per session |
| Revocation | manual | automatic on expiry |
| Storage | in `.env` file | in memory, not persisted |

---

### Authorization — what you can do after auth passes

Authentication answers "who are you." Authorization answers "what are you allowed to do." For the GitHub MCP server, authorization is driven entirely by what scopes your token has:

```
token with only `repo` scope
  → can call get_file_contents ✓
  → cannot call create_repository if org-level permission missing ✗

token with `repo` + `read:org` scope
  → can call both ✓
```

The MCP server itself does not define permissions — it delegates entirely to GitHub's API. If your token does not have the scope, GitHub returns 403, and the MCP server passes that error back to you.

---

## 9. What is actually running on the remote server

### The server-side architecture

```
internet
   │
   │  HTTPS POST /mcp/
   ▼
[ HTTP server — e.g. Express ]
   │
   ├── auth middleware        ← checks Authorization header first
   │
   └── /mcp route handler    ← passes request to MCP SDK
            │
            ▼
   [ MCP Server (SDK) ]       ← speaks JSON-RPC, runs tool handlers
            │
            ▼
   [ tool handler functions ] ← actual business logic (calls GitHub API, reads files, etc.)
```

Yes — there are two layers. Underneath is a normal HTTP server. The MCP SDK plugs into it as a route handler.

---

### What the server code actually looks like

A minimal remote MCP server built with Express + the MCP SDK:

```ts
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

const app = express();
app.use(express.json());

// layer 1 — auth middleware, runs before MCP touches anything
app.use('/mcp', (req, res, next) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!isValidToken(token)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
});

// layer 2 — MCP handler
const mcpServer = new McpServer({ name: 'my-server', version: '1.0.0' });

// register tools
mcpServer.tool('read_file', schema, async ({ path }) => {
  const content = await fs.readFile(path, 'utf8');
  return { content };
});

app.post('/mcp', async (req, res) => {
  const transport = new StreamableHTTPServerTransport();
  await mcpServer.connect(transport);
  await transport.handleRequest(req, res);
});

app.listen(3000);
```

---

### Does it spawn a child process on the server?

It depends on what the server's tools do.

**No subprocess — tools are just functions** (most common):
```
client request
   → Express route
   → MCP SDK parses JSON-RPC
   → calls tool handler function
   → function calls GitHub REST API / reads DB / etc.
   → returns result
```

**With subprocess — server wraps a stdio MCP server** (less common, but possible):
```
client request
   → Express route
   → MCP SDK parses JSON-RPC
   → forwards to a child process via stdin/stdout
   → child process does the work
   → result comes back via stdout
   → returned to client
```

This second pattern is what we do locally — except someone put an HTTP server in front of it so it can be accessed remotely.

---

### For GitHub's specific case

`api.githubcopilot.com/mcp/` is not a simple Express app — it runs behind GitHub's infrastructure (load balancers, multiple instances, etc.). But the concept is the same: an HTTP layer validates your token, and an MCP layer handles the JSON-RPC and calls GitHub's own REST/GraphQL APIs internally. No subprocess involved.

---

### Summary

| layer | what it does | technology |
|---|---|---|
| HTTP server | receives requests, handles auth | Express / Fastify / any HTTP framework |
| MCP SDK | parses JSON-RPC, routes to tool handlers | `@modelcontextprotocol/sdk` server |
| Tool handlers | actual work — call APIs, read files, etc. | your own code |
