import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  detectOpenApi,
  listOpenApiEndpoints,
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

  it("revalidates discovered specs when the canonical document gains new endpoints", async () => {
    const inputUrl = "https://fresh.example.com/api";
    const documentUrl =
      "https://fresh.example.com/request-docs/api?openapi=true";
    let includeProjectPermissions = false;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;

        if (url === inputUrl) {
          return new Response("Not Found", { status: 404 });
        }

        if (url !== documentUrl) {
          return new Response("Not Found", { status: 404 });
        }

        return jsonResponse({
          openapi: "3.0.0",
          info: {
            title: "Fresh API",
            version: "1.0.0",
          },
          paths: {
            "/api/projects/getAll": {
              get: {
                summary: "List projects",
                responses: {
                  "200": {
                    description: "OK",
                  },
                },
              },
            },
            ...(includeProjectPermissions
              ? {
                  "/api/projects/getProjectPermissions": {
                    get: {
                      summary: "List project permissions",
                      responses: {
                        "200": {
                          description: "OK",
                        },
                      },
                    },
                    head: {
                      summary: "List project permissions",
                      responses: {
                        "200": {
                          description: "OK",
                        },
                      },
                    },
                  },
                }
              : {}),
          },
        });
      }),
    );

    const initialSummary = await detectOpenApi(inputUrl);
    expect(initialSummary.endpointCount).toBe(1);

    includeProjectPermissions = true;

    const refreshed = await listOpenApiEndpoints(inputUrl, { limit: 10 });
    expect(refreshed.totalEndpoints).toBe(3);
    expect(refreshed.endpoints).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "GET",
          path: "/api/projects/getProjectPermissions",
        }),
        expect.objectContaining({
          method: "HEAD",
          path: "/api/projects/getProjectPermissions",
        }),
      ]),
    );
  });

  it("avoids weak-schema workflow nonsense and respects public login endpoints", async () => {
    const specUrl = "https://weak.example.com/openapi.json";

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
          openapi: "3.0.0",
          info: {
            title: "Weak API",
            version: "1.0.0",
          },
          security: [{ bearerAuth: [] }],
          components: {
            securitySchemes: {
              bearerAuth: {
                type: "http",
                scheme: "bearer",
              },
            },
          },
          paths: {
            "/api/login": {
              post: {
                description:
                  "Gerekli permission: Yok. Bu endpoint herkese açıktır. Başarılı girişte response içinde bir Sanctum token döner.",
                responses: {
                  "200": {
                    description: "OK",
                    content: {
                      "application/json": {
                        schema: {
                          type: "object",
                        },
                      },
                    },
                  },
                },
                requestBody: {
                  required: true,
                  content: {
                    "application/json": {
                      schema: {
                        type: "object",
                        properties: {
                          email: { type: "string" },
                          password: { type: "string" },
                        },
                      },
                    },
                  },
                },
              },
            },
            "/api/users/store": {
              post: {
                description: "Yeni kullanıcı oluşturur.",
                responses: {
                  "201": {
                    description: "Created",
                    content: {
                      "application/json": {
                        schema: {
                          type: "object",
                        },
                      },
                    },
                  },
                },
              },
            },
            "/api/projects/getAll": {
              get: {
                responses: {
                  "200": {
                    description: "OK",
                    content: {
                      "application/json": {
                        schema: { type: "object" },
                      },
                    },
                  },
                },
              },
              head: {
                responses: {
                  "200": {
                    description: "OK",
                    content: {
                      "application/json": {
                        schema: { type: "object" },
                      },
                    },
                  },
                },
              },
            },
            "/api/projects/delete": {
              delete: {
                responses: {
                  "200": {
                    description: "Deleted",
                    content: {
                      "application/json": {
                        schema: { type: "object" },
                      },
                    },
                  },
                },
              },
            },
            "/api/projects/store": {
              post: {
                description: "Yeni proje oluşturur.",
                responses: {
                  "201": {
                    description: "Created",
                    content: {
                      "application/json": {
                        schema: { type: "object" },
                      },
                    },
                  },
                },
              },
            },
            "/api/projects/syncUserPermissions": {
              post: {
                description: "Proje kullanıcı yetkilerini günceller.",
                requestBody: {
                  required: true,
                  content: {
                    "application/json": {
                      schema: {
                        type: "object",
                        required: ["project_id", "user_id", "permission_ids"],
                        properties: {
                          project_id: { type: "integer" },
                          user_id: { type: "integer" },
                          permission_ids: { type: "array" },
                        },
                      },
                    },
                  },
                },
                responses: {
                  "200": {
                    description: "OK",
                    content: {
                      "application/json": {
                        schema: { type: "object" },
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
      targetPath: "/api/projects/syncUserPermissions",
    });

    const steps = result.workflows[0]?.steps ?? [];
    expect(steps[0]).toMatchObject({
      method: "POST",
      path: "/api/login",
    });
    expect(steps.at(-1)).toMatchObject({
      method: "POST",
      path: "/api/projects/syncUserPermissions",
    });
    expect(steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "POST",
          path: "/api/projects/store",
        }),
        expect.objectContaining({ method: "POST", path: "/api/users/store" }),
      ]),
    );
    expect(steps).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "HEAD",
          path: "/api/projects/getAll",
        }),
        expect.objectContaining({
          method: "DELETE",
          path: "/api/projects/delete",
        }),
      ]),
    );
    expect(result.workflows[0]?.missingDependencies).not.toContain(
      "accessToken",
    );
  });

  it("does not treat sibling approval actions as prerequisites without real produced outputs", async () => {
    const specUrl = "https://approval.example.com/openapi.json";

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
          openapi: "3.0.0",
          info: {
            title: "Approval API",
            version: "1.0.0",
          },
          paths: {
            "/api/user/autoLogin": {
              post: {
                summary: "Auto login",
                responses: {
                  "200": {
                    description: "OK",
                    content: {
                      "application/json": {
                        schema: {
                          type: "object",
                        },
                      },
                    },
                  },
                },
              },
            },
            "/api/user/bordro/approval/{token}": {
              get: {
                summary: "Public approval detail",
                description: "public endpoint",
                parameters: [
                  {
                    name: "token",
                    in: "path",
                    required: true,
                    schema: { type: "string" },
                  },
                ],
                responses: {
                  "200": {
                    description: "OK",
                    content: {
                      "application/json": {
                        schema: {
                          type: "object",
                        },
                      },
                    },
                  },
                },
              },
            },
            "/api/user/bordro/approval/requestOtp": {
              post: {
                summary: "Request OTP",
                description: "public endpoint",
                requestBody: {
                  required: true,
                  content: {
                    "application/json": {
                      schema: {
                        type: "object",
                        required: ["token"],
                        properties: {
                          token: { type: "string" },
                        },
                      },
                    },
                  },
                },
                responses: {
                  "200": {
                    description: "OK",
                    content: {
                      "application/json": {
                        schema: {
                          type: "object",
                        },
                      },
                    },
                  },
                },
              },
            },
            "/api/user/bordro/approval/approve": {
              post: {
                summary: "Approve bordro",
                description: "public endpoint",
                requestBody: {
                  required: true,
                  content: {
                    "application/json": {
                      schema: {
                        type: "object",
                        required: ["token", "otp"],
                        properties: {
                          token: { type: "string" },
                          otp: { type: "string" },
                        },
                      },
                    },
                  },
                },
                responses: {
                  "200": {
                    description: "OK",
                    content: {
                      "application/json": {
                        schema: {
                          type: "object",
                        },
                      },
                    },
                  },
                },
              },
            },
            "/api/user/bordro/approval/reject": {
              post: {
                summary: "Reject bordro",
                description: "public endpoint",
                requestBody: {
                  required: true,
                  content: {
                    "application/json": {
                      schema: {
                        type: "object",
                        required: ["token", "otp", "rejection_reason"],
                        properties: {
                          token: { type: "string" },
                          otp: { type: "string" },
                          rejection_reason: { type: "string" },
                        },
                      },
                    },
                  },
                },
                responses: {
                  "200": {
                    description: "OK",
                    content: {
                      "application/json": {
                        schema: {
                          type: "object",
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
      targetPath: "/api/user/bordro/approval/approve",
    });

    const steps = result.workflows[0]?.steps ?? [];
    expect(steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "POST",
          path: "/api/user/bordro/approval/approve",
        }),
      ]),
    );
    expect(steps).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "POST",
          path: "/api/user/bordro/approval/reject",
        }),
      ]),
    );
  });
});
