# How MCP Communication Works

## 1. The `mcpServer` config — no HTTP, just a subprocess

When you write:

```ts
const myFsClient = createMcpClient({
  name: 'myFileSystemClient',
  mcpServer: {
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', process.cwd()],
  },
});
```

Genkit does **not** start an HTTP server. It spawns the command as a child process and communicates with it over **stdin/stdout** (the stdio transport). No network port is opened.

The alternative — the `remote/` pattern — would use HTTP+SSE transport where you pass a URL instead of a command.

---

## 2. What are stdin and stdout?

Every process gets three streams automatically when it starts:

```
keyboard / parent process
        │
        │  stdin  (stream IN  — data going INTO  your program)
        ▼
  [ your program ]
        │
        │  stdout (stream OUT — data coming OUT of your program)
        ▼
   terminal / parent process
```

You already use them without thinking:

```bash
# echo writes to stdout — appears in your terminal
echo "hello"

# cat reads from stdin — waits for you to type, then prints it back
cat

# pipe: stdout of echo becomes stdin of grep
echo "hello world" | grep "world"
```

When Node.js spawns a child process, it gets handles to that child's stdin and stdout — so instead of keyboard/terminal, **the parent process is on both ends of the pipe**.

---

## 3. How the MCP client uses stdin/stdout

```
genkit (parent process)            filesystem server (child process)
        │                                      │
        │  ──── write to child's stdin ────►   │  reads from its stdin
        │                                      │  does the work
        │  ◄─── reads child's stdout ────────  │  writes result to its stdout
```

In Node.js this is just:

```js
import { spawn } from 'child_process';

const child = spawn('npx', ['-y', '@modelcontextprotocol/server-filesystem', './files']);

// send a message TO the server
child.stdin.write('{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n');

// receive a message FROM the server
child.stdout.on('data', (chunk) => {
  console.log(chunk.toString());
});
```

Each message is one line of JSON, terminated by `\n`.

---

## 4. What is JSON-RPC 2.0?

**RPC (Remote Procedure Call)** is the idea of calling a function that lives in another process as if it were a local function:

```
// what you WISH you could write:
const tools = server.listTools();

// what actually happens:
// 1. serialize the call into a message
// 2. send it over some transport (stdin, HTTP, socket...)
// 3. wait for a response
// 4. deserialize the result
```

**JSON-RPC 2.0** is a standard that defines what those messages look like, using JSON. The full spec is one page — it says nothing about transport, authentication, or what methods exist. It is purely an envelope format.

---

## 5. The 4 message types

### Request — you want a result back

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/list",
  "params": { "cursor": null }
}
```

| field | purpose |
|---|---|
| `jsonrpc` | always `"2.0"`, identifies the protocol version |
| `id` | your chosen identifier — the response will echo it back |
| `method` | the function you are calling |
| `params` | the arguments (optional) |

---

### Response (success) — the result comes back

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "tools": [
      { "name": "read_file" },
      { "name": "list_directory" }
    ]
  }
}
```

The `id: 1` matches the request — that is how you know this response belongs to that request.

---

### Response (error) — something went wrong

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "error": {
    "code": -32601,
    "message": "Method not found",
    "data": "tools/explode is not a valid method"
  }
}
```

Standard error codes:

| code | meaning |
|---|---|
| `-32700` | Parse error (invalid JSON) |
| `-32600` | Invalid request structure |
| `-32601` | Method not found |
| `-32602` | Invalid params |
| `-32603` | Internal error |

---

### Notification — fire and forget, no response expected

```json
{
  "jsonrpc": "2.0",
  "method": "notifications/initialized"
}
```

No `id` field — that is the signal that no response is expected. MCP uses this for the post-handshake acknowledgement.

---

## 6. Why `id` matters — async multiplexing

Without `id`, if you send multiple requests you cannot tell which response belongs to which:

```
you send:  tools/list  (no id)
you send:  tools/call  (no id)

server:    result {...}   ← which request was this for??
server:    result {...}
```

With `id`, it is unambiguous:

```
you send:  { id: 1, method: "tools/list" }
you send:  { id: 2, method: "tools/call" }

server:    { id: 2, result: {...} }   ← answer to tools/call
server:    { id: 1, result: {...} }   ← answer to tools/list
```

The `id` can be any number or string — you choose it, the server echoes it back.

---

## 7. Full MCP message flow

This is the complete sequence of JSON-RPC messages that flow through stdin/stdout during a `ready()` → `getActiveTools()` → `generate()` session:

```
genkit                                     filesystem server
  │                                               │
  │  ── {"id":1, "method":"initialize"} ────────► │
  │  ◄─ {"id":1, "result":{"capabilities":{}}} ── │
  │  ── {"method":"notifications/initialized"} ──► │  (notification, no id)
  │                                               │
  │        [ ready() complete ]                   │
  │                                               │
  │  ── {"id":2, "method":"tools/list"} ─────────► │
  │  ◄─ {"id":2, "result":{"tools":[              │
  │       {"name":"read_file", ...},              │
  │       {"name":"list_directory", ...}          │
  │     ]}} ──────────────────────────────────── │
  │                                               │
  │        [ getActiveTools() complete ]          │
  │                                               │
  │        [ model decides to call read_file ]    │
  │                                               │
  │  ── {"id":3, "method":"tools/call",           │
  │       "params":{"name":"read_file",           │
  │        "arguments":{"path":"hello.txt"}}} ──► │
  │  ◄─ {"id":3, "result":                        │
  │       {"content":"Hello from MCP!"}} ──────── │
  │                                               │
  │        [ result fed back to model ]           │
  │        [ model produces final text response ] │
```

---

## 8. History of JSON-RPC — why it was invented

### The problem: everything before it was painful

#### Sun RPC / ONC RPC (1980s)
The earliest widely-used RPC. Invented by Sun Microsystems, still powering NFS today.

- Binary format using XDR (External Data Representation)
- You wrote an IDL (Interface Definition Language) file, a code generator produced stubs
- Tied mostly to C/Unix systems
- No human-readable messages — hard to debug

#### CORBA (1991)
Common Object Request Broker Architecture. Designed for large enterprise systems, language-neutral.

- Binary protocol (IIOP transport)
- Required an "Object Request Broker" daemon
- Enormous spec — books were written just explaining it
- Notoriously painful to set up and debug

#### Java RMI (1997)
Java's built-in RPC mechanism.

- Simple if you were already in Java
- Java-only — completely useless across languages
- Binary serialization that was fragile across Java versions

#### XML-RPC (1998)
The direct grandfather of JSON-RPC. Created by Dave Winer and Microsoft.

- First RPC protocol to use HTTP as transport — a big deal
- Human-readable (XML)
- But the messages were bloated:

```xml
<!-- calling add(5, 3) -->
<?xml version="1.0"?>
<methodCall>
  <methodName>add</methodName>
  <params>
    <param><value><int>5</int></value></param>
    <param><value><int>3</int></value></param>
  </params>
</methodCall>
```

#### SOAP (1999)
Evolved from XML-RPC. Became the dominant enterprise web service standard of the 2000s.

- Added WSDL (machine-readable contract describing available methods)
- Added WS-Security, WS-ReliableMessaging, WS-* — a sprawling family of standards
- In theory powerful — in practice, notorious for complexity

A minimal SOAP request:

```xml
<?xml version="1.0"?>
<soap:Envelope
  xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"
  xmlns:m="http://example.com/calculator">
  <soap:Header/>
  <soap:Body>
    <m:Add>
      <m:a>5</m:a>
      <m:b>3</m:b>
    </m:Add>
  </soap:Body>
</soap:Envelope>
```

Developers despised it. The joke was that SOAP stood for "Son Of Another Problem."

---

### JSON-RPC arrives (2005 / 2.0 in 2010)

By 2005, JSON was taking over the web. The same `add(5, 3)` call in JSON-RPC:

```json
{ "jsonrpc": "2.0", "id": 1, "method": "add", "params": [5, 3] }
```

One line.

---

### Advantages of JSON-RPC over its predecessors

| | CORBA | SOAP | XML-RPC | JSON-RPC |
|---|---|---|---|---|
| Format | Binary | XML | XML | JSON |
| Human readable | No | Barely | Yes | Yes |
| Spec complexity | Enormous | Very large | Small | One page |
| Transport | IIOP | HTTP only | HTTP only | Anything |
| Language support | IDL stubs required | Code gen required | Decent | Universal |
| Browser native | No | No | No | Yes |

Key wins:

1. **Tiny spec** — one page, nothing to memorize
2. **Transport agnostic** — works over HTTP, WebSocket, stdin/stdout, TCP — anything that carries bytes. This is exactly why MCP can use it over stdin/stdout.
3. **JSON is native to JavaScript** — no parsing library needed in the browser or Node.js
4. **Easy to debug** — you can read the messages with your eyes
5. **No code generation** — SOAP/CORBA required generating client stubs from a schema file first

---

### What came after JSON-RPC

**gRPC (2015, by Google)** went back to binary (Protocol Buffers) for performance, adding streaming and strict schema contracts — at the cost of human readability. Used when you need speed at scale.

**GraphQL (2015, by Facebook)** took a different angle — instead of calling methods, you describe exactly what data shape you want.

JSON-RPC sits in a sweet spot: simple enough to implement in an afternoon, flexible enough to run over any transport, which is exactly why MCP chose it.

---

## 9. Authentication and Authorization for JSON-RPC

JSON-RPC itself has **zero built-in auth** — it is a pure envelope format. Auth is always handled at a layer on top of it. The approach depends on the transport.

---

### When transport is HTTP

This is the most common case. JSON-RPC rides on top of HTTP and inherits everything HTTP offers.

#### API Key in header
```
POST /rpc HTTP/1.1
X-API-Key: secret-key-123
Content-Type: application/json

{ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }
```

#### Bearer token (OAuth 2.0 / JWT)
```
POST /rpc HTTP/1.1
Authorization: Bearer eyJhbGciOiJIUzI1NiJ9...
Content-Type: application/json

{ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }
```

The server validates the token before even looking at the JSON-RPC payload. If the token is invalid, it returns HTTP 401 — the JSON-RPC layer never runs.

#### mTLS (mutual TLS)
Both client and server present certificates to each other during the TLS handshake. No credentials in the HTTP headers or body at all — identity is proven at the connection level. Common in internal microservices.

---

### When transport is stdio (local, like our MCP demo)

**There is no auth.** The parent process spawned the child — trust is implicit at the OS level. Only your own process can write to that child's stdin.

```
your Node process (you own it)
        │
        │  spawns
        ▼
filesystem MCP server (child process)
```

The child inherits the parent's user permissions. If the parent can read `/files`, so can the child. OS-level process isolation is the security boundary.

---

### Embedding credentials inside the JSON-RPC message itself

Less common, used when you cannot control the transport headers (e.g. WebSocket or raw TCP).

#### In `params`
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/list",
  "params": {
    "auth": { "token": "secret-key-123" },
    "cursor": null
  }
}
```

Downside: credentials appear in every single request and in logs. Avoid if you can use headers instead.

#### Login-first pattern
Send one `auth.login` call first, get a session token back, then use that token in all subsequent calls:

```
client → { "method": "auth.login", "params": { "user": "x", "password": "y" } }
server → { "result": { "sessionToken": "abc123", "expiresIn": 3600 } }

client → { "method": "tools/list", "params": { "sessionToken": "abc123" } }
```

---

### Authorization (what you can do, not who you are)

Once identity is established, you restrict which methods a caller can invoke. Since JSON-RPC has no concept of permissions, you implement this in your server's method handler:

```ts
function handleRequest(req, callerRole) {
  if (req.method === 'admin.deleteAll' && callerRole !== 'admin') {
    return {
      jsonrpc: '2.0',
      id: req.id,
      error: { code: -32600, message: 'Forbidden' }
    };
  }
  // proceed
}
```

There is no standard error code for "forbidden" in JSON-RPC — teams usually use `-32600` (Invalid Request) or define their own application-level codes above `-32000`.

---

### What MCP specifically does for remote servers

The MCP spec (2025) added **OAuth 2.0** as the standard auth mechanism for remote HTTP-based MCP servers:

```
client                          MCP server
  │                                  │
  │  GET /.well-known/mcp            │
  │ ◄── { authorizationUrl: "..." } ──│
  │                                  │
  │  (user logs in via OAuth flow)   │
  │                                  │
  │  POST /rpc                       │
  │  Authorization: Bearer <token>   │
  │ ──────────────────────────────► │
```

For local stdio servers (like our demo) — nothing. No auth needed.

---

### Summary

| Transport | Auth mechanism |
|---|---|
| HTTP | Bearer token, API key header, mTLS, OAuth 2.0 |
| WebSocket / TCP | Token in first message or connection handshake |
| stdio (local) | None — OS process isolation is the boundary |
| Remote MCP server | OAuth 2.0 (per MCP 2025 spec) |

The core rule: **JSON-RPC does not care about auth — solve it at the transport layer whenever possible**, and fall back to embedding credentials in params only when the transport gives you no other option.

---

## 10. Summary

| concept | what it is |
|---|---|
| `mcpServer` with `command` | spawns a subprocess, uses stdio transport (no HTTP) |
| stdin | pipe carrying data **into** the child process |
| stdout | pipe carrying data **out of** the child process |
| JSON-RPC 2.0 | a minimal standard for structuring function-call messages as JSON |
| `id` field | links each response back to its request, enabling async multiplexing |
| `ready()` | spawns the process + MCP handshake (`initialize` + `notifications/initialized`) |
| `getActiveTools()` | sends `tools/list`, wraps results as Genkit tools |
| tool execution in `generate()` | sends `tools/call` per tool invocation, feeds result back to the model |
