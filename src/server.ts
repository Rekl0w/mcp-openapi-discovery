import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";
import {
  detectOpenApi,
  formatEndpointSearchResults,
  formatDiscoverySummary,
  formatEndpointDetail,
  formatEndpointList,
  formatParameterUsageTrace,
  formatRelatedEndpoints,
  getOpenApiEndpointDetails,
  listOpenApiEndpoints,
  findRelatedEndpoints,
  searchOpenApiEndpoints,
  traceParameterUsage,
} from "./openapi.js";
import { callOpenApiEndpoint, formatCallEndpointResult } from "./request.js";

function toStructuredContent(value: object): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function createErrorResult(message: string): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: message,
      },
    ],
    isError: true,
    structuredContent: {
      error: message,
    },
  };
}

export function createServer(): McpServer {
  const server = new McpServer(
    {
      name: "mcp-openapi-discovery",
      version: "0.1.0",
    },
    {
      capabilities: {
        logging: {},
      },
    },
  );

  server.registerTool(
    "detect_openapi",
    {
      description:
        "Given a docs or API URL, detect the OpenAPI/Swagger document behind it and summarize the API structure.",
      inputSchema: {
        url: z
          .string()
          .describe("Docs page URL or direct OpenAPI JSON/YAML URL"),
      },
    },
    async ({ url }) => {
      try {
        const summary = await detectOpenApi(url);
        return {
          content: [
            {
              type: "text",
              text: formatDiscoverySummary(summary),
            },
          ],
          structuredContent: toStructuredContent(summary),
        } satisfies CallToolResult;
      } catch (error) {
        return createErrorResult(
          error instanceof Error ? error.message : "OpenAPI detection failed.",
        );
      }
    },
  );

  server.registerTool(
    "list_endpoints",
    {
      description:
        "List endpoints from a discovered OpenAPI document with optional filtering by tag, method, or path fragment.",
      inputSchema: {
        url: z
          .string()
          .describe("Docs page URL or direct OpenAPI JSON/YAML URL"),
        tag: z.string().optional().describe("Optional tag filter, e.g. users"),
        method: z
          .enum([
            "GET",
            "POST",
            "PUT",
            "PATCH",
            "DELETE",
            "OPTIONS",
            "HEAD",
            "TRACE",
          ])
          .optional()
          .describe("Optional HTTP method filter"),
        pathContains: z
          .string()
          .optional()
          .describe("Optional path or summary substring filter"),
        includeDeprecated: z
          .boolean()
          .optional()
          .describe("Include deprecated endpoints; defaults to true"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe("Maximum endpoint count to return; defaults to 50"),
      },
    },
    async ({ url, tag, method, pathContains, includeDeprecated, limit }) => {
      try {
        const result = await listOpenApiEndpoints(url, {
          tag,
          method,
          pathContains,
          includeDeprecated,
          limit,
        });

        return {
          content: [
            {
              type: "text",
              text: formatEndpointList(result),
            },
          ],
          structuredContent: toStructuredContent(result),
        } satisfies CallToolResult;
      } catch (error) {
        return createErrorResult(
          error instanceof Error ? error.message : "Endpoint listing failed.",
        );
      }
    },
  );

  server.registerTool(
    "search_endpoints",
    {
      description:
        "Search cached endpoints for a previously detected OpenAPI spec using a server-side semantic-style scorer over endpoint metadata and schema field names.",
      inputSchema: {
        specId: z.string().describe("Spec ID returned by detect_openapi"),
        query: z
          .string()
          .describe(
            "Natural-language or keyword query, e.g. create user email",
          ),
        tag: z.string().optional().describe("Optional tag filter, e.g. users"),
        method: z
          .enum([
            "GET",
            "POST",
            "PUT",
            "PATCH",
            "DELETE",
            "OPTIONS",
            "HEAD",
            "TRACE",
          ])
          .optional()
          .describe("Optional HTTP method filter"),
        includeDeprecated: z
          .boolean()
          .optional()
          .describe("Include deprecated endpoints; defaults to true"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe(
            "Maximum number of search results to return; defaults to 10",
          ),
      },
    },
    async ({ specId, query, tag, method, includeDeprecated, limit }) => {
      try {
        const result = await searchOpenApiEndpoints(specId, query, {
          tag,
          method,
          includeDeprecated,
          limit,
        });

        return {
          content: [
            {
              type: "text",
              text: formatEndpointSearchResults(result),
            },
          ],
          structuredContent: toStructuredContent(result),
        } satisfies CallToolResult;
      } catch (error) {
        return createErrorResult(
          error instanceof Error ? error.message : "Endpoint search failed.",
        );
      }
    },
  );

  server.registerTool(
    "get_endpoint_details",
    {
      description:
        "Return request/response details for a specific endpoint in the discovered OpenAPI document.",
      inputSchema: {
        url: z
          .string()
          .describe("Docs page URL or direct OpenAPI JSON/YAML URL"),
        method: z
          .enum([
            "GET",
            "POST",
            "PUT",
            "PATCH",
            "DELETE",
            "OPTIONS",
            "HEAD",
            "TRACE",
          ])
          .describe("HTTP method"),
        path: z.string().describe("Exact OpenAPI path, e.g. /api/users/{id}"),
      },
    },
    async ({ url, method, path }) => {
      try {
        const result = await getOpenApiEndpointDetails(url, method, path);
        return {
          content: [
            {
              type: "text",
              text: formatEndpointDetail(result),
            },
          ],
          structuredContent: toStructuredContent(result),
        } satisfies CallToolResult;
      } catch (error) {
        return createErrorResult(
          error instanceof Error ? error.message : "Endpoint lookup failed.",
        );
      }
    },
  );

  server.registerTool(
    "call_endpoint",
    {
      description:
        "Call an endpoint discovered from the OpenAPI document, optionally applying auth automatically and sending query, path, headers, and payload data.",
      inputSchema: {
        url: z
          .string()
          .describe("Docs page URL or direct OpenAPI JSON/YAML URL"),
        method: z
          .enum([
            "GET",
            "POST",
            "PUT",
            "PATCH",
            "DELETE",
            "OPTIONS",
            "HEAD",
            "TRACE",
          ])
          .describe("HTTP method"),
        path: z.string().describe("Exact OpenAPI path, e.g. /users/{id}"),
        pathParams: z
          .record(z.string(), z.unknown())
          .optional()
          .describe('Path template values, e.g. {"id":"42"}'),
        query: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Query string parameters"),
        headers: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Additional request headers"),
        body: z
          .unknown()
          .optional()
          .describe("Request payload for JSON, form, or multipart requests"),
        rawBody: z
          .string()
          .optional()
          .describe("Raw string body to send as-is"),
        contentType: z
          .string()
          .optional()
          .describe("Override request content-type"),
        timeoutMs: z
          .number()
          .int()
          .min(1000)
          .max(120000)
          .optional()
          .describe("Request timeout in milliseconds"),
        auth: z
          .object({
            strategy: z
              .enum([
                "auto",
                "none",
                "basic",
                "bearer",
                "apiKey",
                "oauth2-password",
                "oauth2-client-credentials",
              ])
              .optional()
              .describe("How auth should be applied; defaults to auto"),
            username: z
              .string()
              .optional()
              .describe("Username for basic auth or OAuth password flow"),
            password: z
              .string()
              .optional()
              .describe("Password for basic auth or OAuth password flow"),
            token: z
              .string()
              .optional()
              .describe("Direct bearer or API token if you already have one"),
            apiKey: z
              .string()
              .optional()
              .describe("Direct API key value for apiKey security schemes"),
            apiKeyName: z
              .string()
              .optional()
              .describe("Override API key header/query/cookie name if needed"),
            clientId: z.string().optional().describe("OAuth client_id"),
            clientSecret: z.string().optional().describe("OAuth client_secret"),
            scopes: z.array(z.string()).optional().describe("OAuth scopes"),
            tokenUrl: z
              .string()
              .optional()
              .describe("Override token URL if spec discovery is not enough"),
            tokenResponsePath: z
              .string()
              .optional()
              .describe(
                "Path to access token in token response; defaults to access_token",
              ),
            tokenHeaders: z
              .record(z.string(), z.unknown())
              .optional()
              .describe("Extra headers for token acquisition request"),
            extraTokenParams: z
              .record(z.string(), z.unknown())
              .optional()
              .describe("Extra form params for token acquisition request"),
          })
          .optional()
          .describe("Authentication configuration"),
      },
    },
    async ({
      url,
      method,
      path,
      pathParams,
      query,
      headers,
      body,
      rawBody,
      contentType,
      timeoutMs,
      auth,
    }) => {
      try {
        const result = await callOpenApiEndpoint({
          url,
          method,
          path,
          pathParams,
          query,
          headers,
          body,
          rawBody,
          contentType,
          timeoutMs,
          auth,
        });

        return {
          content: [
            {
              type: "text",
              text: formatCallEndpointResult(result),
            },
          ],
          structuredContent: toStructuredContent(result),
        } satisfies CallToolResult;
      } catch (error) {
        return createErrorResult(
          error instanceof Error ? error.message : "Endpoint call failed.",
        );
      }
    },
  );

  server.registerTool(
    "trace_parameter_usage",
    {
      description:
        "Trace where a parameter or field such as userId is used across path parameters, query parameters, request bodies, and response bodies.",
      inputSchema: {
        url: z
          .string()
          .describe("Docs page URL or direct OpenAPI JSON/YAML URL"),
        parameterName: z
          .string()
          .describe("Parameter or field name to trace, e.g. userId"),
        entityName: z
          .string()
          .optional()
          .describe("Optional entity hint, e.g. user"),
        method: z
          .enum([
            "GET",
            "POST",
            "PUT",
            "PATCH",
            "DELETE",
            "OPTIONS",
            "HEAD",
            "TRACE",
          ])
          .optional()
          .describe("Optional method filter"),
        path: z.string().optional().describe("Optional exact path filter"),
        includeRequestBodies: z
          .boolean()
          .optional()
          .describe("Include request body field matching; defaults to true"),
        includeResponseBodies: z
          .boolean()
          .optional()
          .describe("Include response body field matching; defaults to true"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(300)
          .optional()
          .describe("Maximum number of matches to return"),
      },
    },
    async ({
      url,
      parameterName,
      entityName,
      method,
      path,
      includeRequestBodies,
      includeResponseBodies,
      limit,
    }) => {
      try {
        const result = await traceParameterUsage(url, parameterName, {
          entityName,
          method,
          path,
          includeRequestBodies,
          includeResponseBodies,
          limit,
        });

        return {
          content: [
            {
              type: "text",
              text: formatParameterUsageTrace(result),
            },
          ],
          structuredContent: toStructuredContent(result),
        } satisfies CallToolResult;
      } catch (error) {
        return createErrorResult(
          error instanceof Error ? error.message : "Parameter tracing failed.",
        );
      }
    },
  );

  server.registerTool(
    "find_related_endpoints",
    {
      description:
        "Find endpoints that are structurally related to a source endpoint based on shared resource paths, identifiers, tags, and parent/child URL patterns.",
      inputSchema: {
        url: z
          .string()
          .describe("Docs page URL or direct OpenAPI JSON/YAML URL"),
        method: z
          .enum([
            "GET",
            "POST",
            "PUT",
            "PATCH",
            "DELETE",
            "OPTIONS",
            "HEAD",
            "TRACE",
          ])
          .describe("Source endpoint HTTP method"),
        path: z.string().describe("Source endpoint path, e.g. /users/{id}"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Maximum number of related endpoints to return"),
      },
    },
    async ({ url, method, path, limit }) => {
      try {
        const result = await findRelatedEndpoints(url, method, path, { limit });
        return {
          content: [
            {
              type: "text",
              text: formatRelatedEndpoints(result),
            },
          ],
          structuredContent: toStructuredContent(result),
        } satisfies CallToolResult;
      } catch (error) {
        return createErrorResult(
          error instanceof Error
            ? error.message
            : "Related endpoint discovery failed.",
        );
      }
    },
  );

  return server;
}
