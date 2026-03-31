import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findRelatedEndpoints, traceParameterUsage } from "../src/openapi.js";

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: {
      "content-type": "application/json",
    },
  });
}

describe("structured tracing", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("traces parameter usage across parameters and schema fields", async () => {
    const specUrl = "https://graph.example.com/openapi.json";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        if (url !== specUrl) {
          return new Response("Not Found", { status: 404 });
        }

        return jsonResponse({
          openapi: "3.1.0",
          info: {
            title: "Graph API",
            version: "1.0.0",
          },
          servers: [{ url: "https://graph.example.com/api" }],
          paths: {
            "/users/{id}": {
              get: {
                tags: ["users"],
                parameters: [
                  {
                    name: "id",
                    in: "path",
                    required: true,
                    schema: { type: "string" },
                  },
                ],
                responses: {
                  "200": {
                    description: "ok",
                    content: {
                      "application/json": {
                        schema: {
                          type: "object",
                          properties: {
                            userId: { type: "string" },
                            profile: {
                              type: "object",
                              properties: {
                                accountId: { type: "string" },
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
            "/users/{id}/permissions": {
              get: {
                tags: ["users"],
                parameters: [
                  {
                    name: "id",
                    in: "path",
                    required: true,
                    schema: { type: "string" },
                  },
                ],
                responses: {
                  "200": {
                    description: "ok",
                  },
                },
              },
            },
            "/orders": {
              get: {
                tags: ["orders"],
                parameters: [
                  {
                    name: "userId",
                    in: "query",
                    required: false,
                    schema: { type: "string" },
                  },
                ],
                responses: {
                  "200": {
                    description: "ok",
                  },
                },
              },
            },
            "/sessions": {
              post: {
                tags: ["auth"],
                requestBody: {
                  required: true,
                  content: {
                    "application/json": {
                      schema: {
                        type: "object",
                        properties: {
                          username: { type: "string" },
                          password: { type: "string" },
                        },
                      },
                    },
                  },
                },
                responses: {
                  "200": {
                    description: "ok",
                    content: {
                      "application/json": {
                        schema: {
                          type: "object",
                          properties: {
                            accessToken: { type: "string" },
                            userId: { type: "string" },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        });
      }),
    );

    const result = await traceParameterUsage(specUrl, "userId");

    expect(result.totalMatches).toBeGreaterThanOrEqual(4);
    expect(result.matches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "GET",
          path: "/orders",
          location: "query-parameter",
          fieldName: "userId",
        }),
        expect.objectContaining({
          method: "GET",
          path: "/users/{id}",
          location: "path-parameter",
          matchedBy: "entity-id-heuristic",
        }),
        expect.objectContaining({
          method: "GET",
          path: "/users/{id}",
          location: "response-body",
          fieldPath: "userId",
        }),
        expect.objectContaining({
          method: "POST",
          path: "/sessions",
          location: "response-body",
          fieldPath: "userId",
        }),
      ]),
    );
  });

  it("finds structurally related endpoints for a source endpoint", async () => {
    const specUrl = "https://graph.example.com/openapi.json";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        if (url !== specUrl) {
          return new Response("Not Found", { status: 404 });
        }

        return jsonResponse({
          openapi: "3.1.0",
          info: {
            title: "Graph API",
            version: "1.0.0",
          },
          paths: {
            "/users/{id}": {
              get: {
                tags: ["users"],
                parameters: [
                  {
                    name: "id",
                    in: "path",
                    required: true,
                    schema: { type: "string" },
                  },
                ],
                responses: {
                  "200": {
                    description: "ok",
                    content: {
                      "application/json": {
                        schema: {
                          type: "object",
                          properties: {
                            userId: { type: "string" },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
            "/users/{id}/permissions": {
              get: {
                tags: ["users"],
                parameters: [
                  {
                    name: "id",
                    in: "path",
                    required: true,
                    schema: { type: "string" },
                  },
                ],
                responses: {
                  "200": { description: "ok" },
                },
              },
            },
            "/orders": {
              get: {
                tags: ["orders"],
                parameters: [
                  {
                    name: "userId",
                    in: "query",
                    required: false,
                    schema: { type: "string" },
                  },
                ],
                responses: {
                  "200": { description: "ok" },
                },
              },
            },
            "/teams/{teamId}": {
              get: {
                tags: ["teams"],
                parameters: [
                  {
                    name: "teamId",
                    in: "path",
                    required: true,
                    schema: { type: "string" },
                  },
                ],
                responses: {
                  "200": { description: "ok" },
                },
              },
            },
          },
        });
      }),
    );

    const result = await findRelatedEndpoints(specUrl, "GET", "/users/{id}");

    expect(result.relatedEndpoints.length).toBeGreaterThanOrEqual(2);
    expect(result.relatedEndpoints[0]).toMatchObject({
      method: "GET",
      path: "/users/{id}/permissions",
    });
    expect(result.relatedEndpoints).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "/orders",
        }),
      ]),
    );
    expect(
      result.relatedEndpoints
        .find((item) => item.path === "/orders")
        ?.reasons.join(" "),
    ).toContain("identifier");
  });
});
