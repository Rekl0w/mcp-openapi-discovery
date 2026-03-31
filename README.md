# @rekl0w/mcp-openapi-discovery

`@rekl0w/mcp-openapi-discovery` is a TypeScript MCP server that can:

- detect OpenAPI / Swagger documents from a URL,
- inspect and summarize endpoints,
- trace field and identifier usage across the API,
- and execute real HTTP requests against those endpoints with auth and payload support.

It is designed for documentation-first API workflows where you want an MCP client to move from **"find the spec"** to **"understand the endpoint"** to **"call the endpoint"**.

Published package:

- npm: [@rekl0w/mcp-openapi-discovery](https://www.npmjs.com/package/@rekl0w/mcp-openapi-discovery)

## Why this project exists

Many APIs expose documentation pages, but not always the raw spec URL directly. This server helps bridge that gap by discovering the OpenAPI document behind a docs page and turning it into callable MCP tools.

It is especially useful for:

- Swagger UI deployments
- ReDoc documentation pages
- Laravel + L5 Swagger projects
- APIs exposing `openapi.json`, `swagger.json`, `openapi.yaml`, or `swagger.yaml`
- docs pages that reference the spec indirectly through HTML or JS config

## Features

- Detect OpenAPI / Swagger specs from docs pages or direct spec URLs
- Assign a stable in-memory `specId` for each detected spec so later tools can work without re-exposing the full document
- Persist discovered specs on disk so `specId`-based tools can survive process restarts
- Summarize API metadata, servers, tags, and endpoint counts
- List endpoints with filtering by method, tag, or path fragment
- Search endpoints server-side with weighted matching across methods, paths, tags, summaries, parameters, schema field names, synonyms, and operation intent
- Inspect request / response details for a specific endpoint
- Trace where identifiers like `userId`, `accountId`, or `teamId` appear across parameters and schemas
- Find endpoints that are structurally related to another endpoint
- Suggest likely multi-step API workflows such as login → create category → create attribute → create product
- Bundle external `$ref` files and remote schema references into a local in-memory document before analysis
- Execute endpoints with:
  - path params
  - query params
  - custom headers
  - JSON payloads
  - form-urlencoded payloads
  - basic multipart form data
- Apply authentication with:
  - Basic auth
  - Bearer tokens
  - API keys
  - OAuth 2.0 password flow
  - OAuth 2.0 client credentials flow
  - automatic auth selection based on the OpenAPI security scheme

## Available MCP tools

- `detect_openapi`: detects the OpenAPI document behind a docs page or spec URL and returns a summary
- `list_endpoints`: lists endpoints with optional filtering
- `search_endpoints`: searches cached endpoints for a detected spec using server-side weighted scoring
- `suggest_call_sequence`: suggests a likely prerequisite call chain for a target endpoint or a natural-language goal
- `get_endpoint_details`: returns request / response details for a single endpoint
- `trace_parameter_usage`: traces where a parameter or field is used across parameters, request bodies, and response bodies
- `find_related_endpoints`: finds endpoints related to a source endpoint through shared resources, identifiers, and path structure
- `call_endpoint`: executes a real request against an endpoint discovered from the OpenAPI document

## Requirements

- Node.js 18+
- npm 9+ recommended

## Installation

Install from npm:

```bash
npm i @rekl0w/mcp-openapi-discovery
```

Or install project dependencies when working from source:

```bash
npm install
npm run build
```

## Running locally

Run the stdio MCP server after building:

```bash
node dist/index.js
```

For development:

```bash
npm run dev
```

## Connecting from an MCP client

The easiest way to use the published package in MCP clients is to let the client auto-install and run it through `npx`.

### Auto-install from npm with `npx`

If your MCP client supports a `command` + `args` stdio server definition, use:

```json
{
  "command": "npx",
  "args": ["-y", "@rekl0w/mcp-openapi-discovery"]
}
```

This is usually the cleanest setup for clients such as VS Code and Cursor-like MCP clients because the package is downloaded automatically when the server starts.

### VS Code (`.vscode/mcp.json`)

VS Code supports `mcp.json` and can run local MCP servers through `npx`.

```json
{
  "servers": {
    "openapi-discovery": {
      "command": "npx",
      "args": ["-y", "@rekl0w/mcp-openapi-discovery"]
    }
  }
}
```

### Cursor-style MCP config

For MCP clients that use a JSON config with `mcpServers`, a typical setup looks like this:

```json
{
  "mcpServers": {
    "openapi-discovery": {
      "command": "npx",
      "args": ["-y", "@rekl0w/mcp-openapi-discovery"]
    }
  }
}
```

### Local build instead of npm

If you prefer to run the local build directly instead of using npm, point your MCP client at `dist/index.js`.

### Claude Desktop example (Windows)

Add this to `%APPDATA%\Claude\claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "openapi-discovery": {
      "command": "node",
      "args": ["C:/absolute/path/to/project/dist/index.js"]
    }
  }
}
```

> Use an absolute path. On Windows, either forward slashes or escaped backslashes work.

## Example use cases

- Detect the spec behind `https://example.com/docs`
- Detect a spec, keep the returned `specId`, and search only the most relevant endpoints
- Detect a spec, keep the returned `specId`, and reuse it across restarts via persistent cache
- List endpoints from `https://api.example.com/openapi.json`
- Inspect the `PUT /users/{id}` endpoint
- Filter only `POST` endpoints tagged with `users`
- Ask the server for a likely workflow such as “create product with category and attributes”
- Trace where `userId` appears across the API
- Find endpoints related to `GET /users/{id}`
- Send a real `POST /orders` request with a JSON payload
- Log in with username/password, obtain a token, and call a protected endpoint

## Structured tracing

Beyond plain endpoint listing, this server can help answer questions like:

- “Where is `userId` used?”
- “Which endpoints are related to `GET /users/{id}`?”
- “Is this identifier coming from a response body, a query parameter, or a path parameter?”

This now combines structured analysis with lightweight server-side endpoint search. Instead of only doing natural-language similarity on the client, the server can inspect and score:

- path parameters
- query parameters
- request body fields
- response body fields
- shared resource names in paths
- shared identifier patterns such as `userId`, `accountId`, `teamId`, or entity-specific `id` fields

### `specId` + `search_endpoints` flow

Run `detect_openapi` first and keep the returned `specId`.

Then call `search_endpoints` with that `specId` and a natural-language query such as:

- `create user email`
- `refresh bearer token`
- `order status update`

The server builds a searchable text index per endpoint from:

- HTTP method and path
- operationId, summary, description, and tags
- parameter names
- request body field names
- response body field names

This keeps endpoint retrieval on the server side and returns only the top matches.

The search scorer also adds intent-aware bonuses so queries like `add order`, `login token`, or `edit product` can still match `createOrder`, auth endpoints, and `PATCH`/`PUT` style operations without embeddings.

### `suggest_call_sequence` flow

Use `suggest_call_sequence` when the hard part is not finding the endpoint, but figuring out the order of dependent calls.

It can work in two modes:

- by exact target endpoint: `targetMethod` + `targetPath`
- by natural-language goal: `goal`

The server analyzes:

- auth requirements
- path parameter dependencies
- request body identifier fields such as `categoryId`, `attributeId`, `fileId`, or `parentId`
- response body outputs such as `id`, `accessToken`, or resource-specific identifiers
- parent/child path relationships

This makes it possible to suggest chains like:

- login → create category → create category attribute → create product
- login → create customer → create order
- upload file → create entity using returned file id

### Persistent cache

Detected specs are cached to disk and keyed by both normalized input URL and `specId`.

That means `search_endpoints` and `suggest_call_sequence` can keep working even after the process restarts, as long as the cached spec is still within the cache TTL.

If needed, you can override the cache directory with the `MCP_OPENAPI_DISCOVERY_CACHE_DIR` environment variable.

### Example tracing queries

Use `trace_parameter_usage` when you want to follow a field such as `userId` across the API surface.

Use `find_related_endpoints` when you already know one endpoint and want to discover nearby or dependent endpoints, such as child resources or endpoints using the same identifiers.

## Endpoint execution and authentication

The `call_endpoint` tool can execute actual API calls, not just describe them.

Supported auth strategies:

- `basic`
- `bearer`
- `apiKey`
- `oauth2-password`
- `oauth2-client-credentials`
- `auto`

In `auto` mode, the tool inspects the endpoint’s effective OpenAPI security requirements and tries to apply the most appropriate authentication strategy from the credentials you provide.

### Supported request body styles

- JSON
- `application/x-www-form-urlencoded`
- simple `multipart/form-data`
- raw string bodies via `rawBody`

You can also override the outgoing content type explicitly with `contentType`.

## Example `call_endpoint` inputs

### JSON body + API key

```json
{
  "url": "https://orders.example.com/openapi.json",
  "method": "POST",
  "path": "/orders",
  "body": {
    "productId": 42,
    "quantity": 3
  },
  "auth": {
    "apiKey": "your-api-key"
  }
}
```

### OAuth password flow

```json
{
  "url": "https://auth.example.com/openapi.json",
  "method": "GET",
  "path": "/me",
  "auth": {
    "username": "demo",
    "password": "super-secret",
    "clientId": "client",
    "clientSecret": "client-secret",
    "scopes": ["profile"]
  }
}
```

### Path params + query params

```json
{
  "url": "https://api.example.com/openapi.json",
  "method": "GET",
  "path": "/users/{id}",
  "pathParams": {
    "id": 123
  },
  "query": {
    "include": ["roles", "permissions"]
  }
}
```

### Direct bearer token

```json
{
  "url": "https://api.example.com/openapi.json",
  "method": "GET",
  "path": "/profile",
  "auth": {
    "strategy": "bearer",
    "token": "your-access-token"
  }
}
```

## Validation

Run the full verification suite with:

```bash
npm run check
```

This runs:

- the TypeScript build
- the Vitest test suite

## Development notes

- Runtime: Node.js 18+
- MCP SDK: `@modelcontextprotocol/sdk` v1
- Spec parsing: JSON / YAML + HTML discovery heuristics + bundled external `$ref` support
- Cache: in-memory + disk-backed spec cache keyed by URL and `specId`
- Workflow planning: dependency inference across auth, path params, request body ids, and response outputs
- Request execution: real HTTP requests with automatic auth handling
- Test runner: `vitest`

## Security notes

- Do not commit real credentials, client secrets, or access tokens.
- Prefer environment-specific client configuration over hardcoded secrets.
- Be careful when using this against production APIs.
- Review OpenAPI specs from untrusted sources carefully, especially when authentication and live request execution are involved.

## Contributing

Issues and pull requests are welcome.

If you want to contribute:

1. fork the repository
2. create a feature branch
3. run `npm run check`
4. open a pull request with a clear description

## Roadmap

- broader Swagger UI / Scalar detection patterns
- richer Laravel-specific API summaries
- optional Streamable HTTP transport support

## License

MIT
