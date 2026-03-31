import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";
import {
  detectOpenApi,
  getOpenApiEndpointDetails,
  listOpenApiEndpoints,
  searchOpenApiEndpoints,
} from "../src/openapi.js";

function installFetchMock(routes: Record<string, Response>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;

      const response = routes[url];
      return response
        ? response.clone()
        : new Response("Not Found", { status: 404 });
    }),
  );
}

function jsonResponse(data: unknown, url: string): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: {
      "content-type": "application/json",
    },
  });
}

function yamlResponse(data: unknown): Response {
  return new Response(stringify(data), {
    status: 200,
    headers: {
      "content-type": "application/yaml",
    },
  });
}

describe("openapi discovery", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("discovers an OpenAPI document from an HTML docs page", async () => {
    const spec = {
      openapi: "3.1.0",
      info: {
        title: "Example API",
        version: "1.2.3",
      },
      servers: [{ url: "https://api.example.com" }],
      paths: {
        "/users": {
          get: {
            summary: "List users",
            tags: ["users"],
            responses: {
              "200": {
                description: "OK",
              },
            },
          },
        },
        "/users/{id}": {
          get: {
            summary: "Get user",
            tags: ["users"],
            responses: {
              "200": {
                description: "OK",
              },
            },
          },
        },
      },
    };

    installFetchMock({
      "https://docs.example.com/reference": new Response(
        '<html><body><redoc spec-url="/openapi.json"></redoc></body></html>',
        {
          status: 200,
          headers: {
            "content-type": "text/html",
          },
        },
      ),
      "https://docs.example.com/openapi.json": jsonResponse(
        spec,
        "https://docs.example.com/openapi.json",
      ),
    });

    const summary = await detectOpenApi("https://docs.example.com/reference");

    expect(summary.documentUrl).toBe("https://docs.example.com/openapi.json");
    expect(["html-link", "common-path"]).toContain(summary.source);
    expect(summary.apiTitle).toBe("Example API");
    expect(summary.endpointCount).toBe(2);
    expect(summary.tags).toEqual(["users"]);
    expect(summary.specId).toMatch(/^spec_[a-f0-9]{16}$/);
  });

  it("lists endpoints from a direct YAML spec with filtering", async () => {
    const spec = {
      openapi: "3.0.3",
      info: {
        title: "Orders API",
        version: "2026-03",
      },
      paths: {
        "/orders": {
          get: {
            summary: "List orders",
            tags: ["orders"],
            responses: {
              "200": { description: "OK" },
            },
          },
          post: {
            summary: "Create order",
            tags: ["orders"],
            responses: {
              "201": { description: "Created" },
            },
          },
        },
        "/health": {
          get: {
            summary: "Health check",
            tags: ["infra"],
            responses: {
              "200": { description: "OK" },
            },
          },
        },
      },
    };

    installFetchMock({
      "https://api.example.com/swagger.yaml": yamlResponse(spec),
    });

    const result = await listOpenApiEndpoints(
      "https://api.example.com/swagger.yaml",
      {
        method: "POST",
      },
    );

    expect(result.totalEndpoints).toBe(3);
    expect(result.matchedEndpoints).toBe(1);
    expect(result.endpoints[0]).toMatchObject({
      method: "POST",
      path: "/orders",
      summary: "Create order",
    });
  });

  it("returns endpoint details including parameters and request body refs", async () => {
    const spec = {
      openapi: "3.1.0",
      info: {
        title: "Users API",
        version: "1.0.0",
      },
      paths: {
        "/users/{id}": {
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              description: "User id",
              schema: {
                type: "string",
              },
            },
          ],
          put: {
            summary: "Update user",
            tags: ["users"],
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    $ref: "#/components/schemas/UpdateUserRequest",
                  },
                },
              },
            },
            responses: {
              "200": {
                description: "Updated",
                content: {
                  "application/json": {
                    schema: {
                      $ref: "#/components/schemas/User",
                    },
                  },
                },
              },
            },
          },
        },
      },
      components: {
        schemas: {
          User: {
            type: "object",
            required: ["id", "name"],
            properties: {
              id: { type: "string" },
              name: { type: "string" },
            },
          },
          UpdateUserRequest: {
            type: "object",
            required: ["name"],
            properties: {
              name: { type: "string" },
              email: { type: "string", format: "email" },
            },
          },
        },
      },
    };

    installFetchMock({
      "https://users.example.com/openapi.json": jsonResponse(
        spec,
        "https://users.example.com/openapi.json",
      ),
    });

    const result = await getOpenApiEndpointDetails(
      "https://users.example.com/openapi.json",
      "PUT",
      "/users/{id}",
    );

    expect(result.endpoint.parameters).toHaveLength(1);
    expect(result.endpoint.parameters[0]).toMatchObject({
      name: "id",
      in: "path",
      required: true,
    });
    expect(result.endpoint.requestBody?.entries[0]).toMatchObject({
      contentType: "application/json",
    });
    expect(result.endpoint.requestBody?.entries[0]?.schema?.refName).toBe(
      "UpdateUserRequest",
    );
    expect(result.endpoint.responses[0]).toMatchObject({
      status: "200",
    });
  });

  it("searches endpoints from cached server-side index using specId", async () => {
    const specUrl = "https://shop.example.com/openapi.json";
    installFetchMock({
      [specUrl]: jsonResponse(
        {
          openapi: "3.1.0",
          info: {
            title: "Shop API",
            version: "1.0.0",
          },
          paths: {
            "/orders": {
              post: {
                operationId: "createOrder",
                summary: "Create order",
                tags: ["orders"],
                requestBody: {
                  required: true,
                  content: {
                    "application/json": {
                      schema: {
                        type: "object",
                        properties: {
                          customerEmail: { type: "string", format: "email" },
                          lineItems: {
                            type: "array",
                            items: {
                              type: "object",
                              properties: {
                                productId: { type: "string" },
                              },
                            },
                          },
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
            "/customers": {
              get: {
                summary: "List customers",
                tags: ["customers"],
                responses: {
                  "200": {
                    description: "OK",
                  },
                },
              },
            },
          },
        },
        specUrl,
      ),
    });

    const summary = await detectOpenApi(specUrl);
    const result = await searchOpenApiEndpoints(
      summary.specId,
      "create order customer email",
    );

    expect(result.totalMatches).toBeGreaterThanOrEqual(1);
    expect(result.endpoints[0]).toMatchObject({
      method: "POST",
      path: "/orders",
    });
    expect(result.endpoints[0]?.matchedTerms).toEqual(
      expect.arrayContaining(["create", "order", "customer", "email"]),
    );
  });

  it("bundles external refs into a searchable local document", async () => {
    const specUrl = "https://bundled-users.example.com/openapi.json";
    installFetchMock({
      [specUrl]: jsonResponse(
        {
          openapi: "3.1.0",
          info: {
            title: "Bundled API",
            version: "1.0.0",
          },
          paths: {
            "/users/{id}": {
              get: {
                summary: "Get user",
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
                    description: "OK",
                    content: {
                      "application/json": {
                        schema: {
                          $ref: "./components/schemas.json#/User",
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        specUrl,
      ),
      "https://bundled-users.example.com/components/schemas.json": jsonResponse(
        {
          User: {
            type: "object",
            properties: {
              id: { type: "string" },
              email: { type: "string", format: "email" },
            },
          },
        },
        "https://bundled-users.example.com/components/schemas.json",
      ),
    });

    const result = await getOpenApiEndpointDetails(
      specUrl,
      "GET",
      "/users/{id}",
    );

    expect(
      result.endpoint.responses[0]?.entries[0]?.schema?.propertyKeys,
    ).toEqual(expect.arrayContaining(["id", "email"]));
  });
});
