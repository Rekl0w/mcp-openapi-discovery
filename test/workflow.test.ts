import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  detectOpenApi,
  searchOpenApiEndpoints,
  suggestCallSequence,
} from "../src/openapi.js";

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: {
      "content-type": "application/json",
    },
  });
}

describe("workflow planning and persistent cache", () => {
  let cacheDir = "";

  beforeEach(async () => {
    vi.restoreAllMocks();
    cacheDir = await mkdtemp(join(tmpdir(), "mcp-openapi-discovery-"));
    process.env.MCP_OPENAPI_DISCOVERY_CACHE_DIR = cacheDir;
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.resetModules();
    delete process.env.MCP_OPENAPI_DISCOVERY_CACHE_DIR;
    if (cacheDir) {
      await rm(cacheDir, { recursive: true, force: true });
    }
  });

  it("suggests a chained workflow including auth and prerequisite resource creation", async () => {
    const specUrl = "https://catalog.example.com/openapi.json";

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
            title: "Catalog API",
            version: "1.0.0",
          },
          security: [{ BearerAuth: [] }],
          components: {
            securitySchemes: {
              BearerAuth: {
                type: "http",
                scheme: "bearer",
              },
            },
          },
          paths: {
            "/auth/login": {
              post: {
                security: [],
                summary: "Login user",
                requestBody: {
                  required: true,
                  content: {
                    "application/json": {
                      schema: {
                        type: "object",
                        required: ["email", "password"],
                        properties: {
                          email: { type: "string" },
                          password: { type: "string" },
                        },
                      },
                    },
                  },
                },
                responses: {
                  "200": {
                    description: "Authenticated",
                    content: {
                      "application/json": {
                        schema: {
                          type: "object",
                          properties: {
                            accessToken: { type: "string" },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
            "/categories": {
              post: {
                summary: "Create category",
                requestBody: {
                  required: true,
                  content: {
                    "application/json": {
                      schema: {
                        type: "object",
                        required: ["name"],
                        properties: {
                          name: { type: "string" },
                        },
                      },
                    },
                  },
                },
                responses: {
                  "201": {
                    description: "Created",
                    content: {
                      "application/json": {
                        schema: {
                          type: "object",
                          properties: {
                            id: { type: "string" },
                            name: { type: "string" },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
            "/categories/{categoryId}/attributes": {
              post: {
                summary: "Create category attribute",
                parameters: [
                  {
                    name: "categoryId",
                    in: "path",
                    required: true,
                    schema: { type: "string" },
                  },
                ],
                requestBody: {
                  required: true,
                  content: {
                    "application/json": {
                      schema: {
                        type: "object",
                        required: ["name"],
                        properties: {
                          name: { type: "string" },
                        },
                      },
                    },
                  },
                },
                responses: {
                  "201": {
                    description: "Created",
                    content: {
                      "application/json": {
                        schema: {
                          type: "object",
                          properties: {
                            id: { type: "string" },
                            name: { type: "string" },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
            "/products": {
              post: {
                summary: "Create product",
                requestBody: {
                  required: true,
                  content: {
                    "application/json": {
                      schema: {
                        type: "object",
                        required: ["name", "categoryId", "attributeId"],
                        properties: {
                          name: { type: "string" },
                          categoryId: { type: "string" },
                          attributeId: { type: "string" },
                        },
                      },
                    },
                  },
                },
                responses: {
                  "201": {
                    description: "Created",
                    content: {
                      "application/json": {
                        schema: {
                          type: "object",
                          properties: {
                            id: { type: "string" },
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

    const summary = await detectOpenApi(specUrl);
    const result = await suggestCallSequence({
      specId: summary.specId,
      targetMethod: "POST",
      targetPath: "/products",
    });

    expect(result.workflows).toHaveLength(1);
    expect(
      result.workflows[0]?.steps.map((step) => `${step.method} ${step.path}`),
    ).toEqual([
      "POST /auth/login",
      "POST /categories",
      "POST /categories/{categoryId}/attributes",
      "POST /products",
    ]);
    expect(result.workflows[0]?.coveredDependencies).toEqual(
      expect.arrayContaining(["accessToken", "categoryId", "attributeId"]),
    );
  });

  it("supports goal-based workflow discovery", async () => {
    const specUrl = "https://goal.example.com/openapi.json";

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
            title: "Goal API",
            version: "1.0.0",
          },
          paths: {
            "/categories": {
              post: {
                summary: "Create category",
                responses: {
                  "201": {
                    description: "Created",
                    content: {
                      "application/json": {
                        schema: {
                          type: "object",
                          properties: {
                            id: { type: "string" },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
            "/products": {
              post: {
                operationId: "createProduct",
                summary: "Create product",
                requestBody: {
                  required: true,
                  content: {
                    "application/json": {
                      schema: {
                        type: "object",
                        required: ["categoryId", "name"],
                        properties: {
                          name: { type: "string" },
                          categoryId: { type: "string" },
                        },
                      },
                    },
                  },
                },
                responses: {
                  "201": {
                    description: "Created",
                  },
                },
              },
            },
          },
        });
      }),
    );

    const summary = await detectOpenApi(specUrl);
    const result = await suggestCallSequence({
      specId: summary.specId,
      goal: "create product with category",
    });

    expect(result.targetCandidates?.[0]).toMatchObject({
      method: "POST",
      path: "/products",
    });
    expect(result.workflows[0]?.steps.at(-1)).toMatchObject({
      method: "POST",
      path: "/products",
    });
  });

  it("reloads cached specs by specId and keeps search quality across module reloads", async () => {
    const specUrl = "https://cache.example.com/openapi.json";

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
            title: "Cache API",
            version: "1.0.0",
          },
          paths: {
            "/orders": {
              post: {
                operationId: "createOrder",
                summary: "Create order",
                responses: {
                  "201": {
                    description: "Created",
                  },
                },
              },
            },
          },
        });
      }),
    );

    const summary = await detectOpenApi(specUrl);
    const initialSearch = await searchOpenApiEndpoints(
      summary.specId,
      "add order",
    );
    expect(initialSearch.endpoints[0]).toMatchObject({
      method: "POST",
      path: "/orders",
    });

    vi.resetModules();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Not Found", { status: 404 })),
    );

    const freshModule = await import("../src/openapi.js");
    const cachedSearch = await freshModule.searchOpenApiEndpoints(
      summary.specId,
      "add order",
    );

    expect(cachedSearch.endpoints[0]).toMatchObject({
      method: "POST",
      path: "/orders",
    });
    expect(cachedSearch.endpoints[0]?.matchedTerms).toEqual(
      expect.arrayContaining(["add", "order"]),
    );
  });
});
