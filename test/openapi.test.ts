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

  it("discovers a Laravel Request Docs style spec from the page directory fallback", async () => {
    const docsUrl = "https://docs.example.com/request-docs";
    const specUrl = "https://docs.example.com/request-docs/api?openapi=true";
    const spec = {
      openapi: "3.0.0",
      info: {
        title: "Laravel Request Docs",
        version: "1.0.0",
      },
      paths: {
        "/api/login": {
          post: {
            summary: "Login",
            responses: {
              "200": { description: "OK" },
            },
          },
        },
      },
    };

    installFetchMock({
      [docsUrl]: new Response(
        "<!DOCTYPE html><html><head><title>LRD</title></head><body><div id='app'></div></body></html>",
        {
          status: 200,
          headers: {
            "content-type": "text/html",
          },
        },
      ),
      [specUrl]: jsonResponse(spec, specUrl),
    });

    const summary = await detectOpenApi(docsUrl);

    expect(summary.documentUrl).toBe(specUrl);
    expect(summary.source).toBe("common-path");
    expect(summary.endpointCount).toBe(1);
  });

  it("discovers a Laravel Request Docs spec from a sibling /api input", async () => {
    const apiInputUrl = "https://docs.example.com/api";
    const docsUrl = "https://docs.example.com/request-docs";
    const specUrl = "https://docs.example.com/request-docs/api?openapi=true";
    const spec = {
      openapi: "3.0.0",
      info: {
        title: "Sibling Docs API",
        version: "1.0.0",
      },
      paths: {
        "/api/login": {
          post: {
            summary: "Login",
            responses: {
              "200": { description: "OK" },
            },
          },
        },
      },
    };

    installFetchMock({
      [apiInputUrl]: new Response("Not Found", { status: 404 }),
      [docsUrl]: new Response(
        "<!DOCTYPE html><html><head><title>LRD</title></head><body><div id='app'></div></body></html>",
        {
          status: 200,
          headers: {
            "content-type": "text/html",
          },
        },
      ),
      [specUrl]: jsonResponse(spec, specUrl),
    });

    const summary = await detectOpenApi(apiInputUrl);

    expect(summary.documentUrl).toBe(specUrl);
    expect(summary.apiTitle).toBe("Sibling Docs API");
  });

  it("falls back from an endpoint URL to the origin root docs page", async () => {
    const endpointUrl = "https://app.example.com/api/users/42";
    const rootUrl = "https://app.example.com/";
    const specUrl = "https://app.example.com/openapi.json";
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;

      if (url === endpointUrl) {
        return new Response("Not Found", { status: 404 });
      }

      if (url === rootUrl) {
        return new Response(
          '<html><body><redoc spec-url="/openapi.json"></redoc></body></html>',
          {
            status: 200,
            headers: {
              "content-type": "text/html",
            },
          },
        );
      }

      if (url === specUrl) {
        return jsonResponse(
          {
            openapi: "3.1.0",
            info: {
              title: "Root Docs API",
              version: "1.0.0",
            },
            paths: {
              "/api/users/{id}": {
                get: {
                  summary: "Get user",
                  responses: {
                    "200": { description: "OK" },
                  },
                },
              },
            },
          },
          specUrl,
        );
      }

      return new Response(`Unexpected URL: ${url}`, { status: 404 });
    });

    vi.stubGlobal("fetch", fetchMock);

    const summary = await detectOpenApi(endpointUrl);

    expect(summary.inputUrl).toBe(endpointUrl);
    expect(summary.documentUrl).toBe(specUrl);
    expect(summary.apiTitle).toBe("Root Docs API");
    expect(summary.discoveryTrail).toEqual(
      expect.arrayContaining([`origin root fallback: ${rootUrl}`]),
    );
    expect(
      fetchMock.mock.calls.slice(0, 2).map((call) => String(call[0])),
    ).toEqual([endpointUrl, rootUrl]);
  });

  it("discovers a versioned v3 OpenAPI path from a docs shell page", async () => {
    const docsUrl = "https://petstore.example.com/docs";
    const specUrl = "https://petstore.example.com/api/v3/openapi.json";
    const spec = {
      openapi: "3.0.3",
      info: {
        title: "Versioned API",
        version: "3.0.0",
      },
      paths: {
        "/pets": {
          get: {
            summary: "List pets",
            responses: {
              "200": { description: "OK" },
            },
          },
        },
      },
    };

    installFetchMock({
      [docsUrl]: new Response(
        "<!DOCTYPE html><html><head><title>Docs</title></head><body><div id='swagger-ui'></div></body></html>",
        {
          status: 200,
          headers: {
            "content-type": "text/html",
          },
        },
      ),
      [specUrl]: jsonResponse(spec, specUrl),
    });

    const summary = await detectOpenApi(docsUrl);

    expect(summary.documentUrl).toBe(specUrl);
    expect(summary.endpointCount).toBe(1);
  });

  it("discovers a Swagger UI embedded json config url", async () => {
    const docsUrl = "https://app.example.com/swagger";
    const specUrl = "https://app.example.com/swagger/v1/swagger.json";
    const spec = {
      openapi: "3.0.1",
      info: {
        title: "Platform API",
        version: "v1",
      },
      paths: {
        "/api/health": {
          get: {
            summary: "Health",
            responses: {
              "200": { description: "OK" },
            },
          },
        },
      },
    };

    installFetchMock({
      [docsUrl]: new Response(
        `<!doctype html><html><body><script>window.onload=function(){var configObject = JSON.parse('{"urls":[{"url":"/swagger/v1/swagger.json","name":"Platform API v1"}]}'); const ui = SwaggerUIBundle(configObject);}</script></body></html>`,
        {
          status: 200,
          headers: {
            "content-type": "text/html",
          },
        },
      ),
      [specUrl]: jsonResponse(spec, specUrl),
    });

    const summary = await detectOpenApi(docsUrl);

    expect(summary.documentUrl).toBe(specUrl);
    expect(summary.apiTitle).toBe("Platform API");
  });

  it("discovers a Scalar sources url from the docs page", async () => {
    const docsUrl = "https://app.example.com/scalar";
    const specUrl = "https://app.example.com/swagger/v1/swagger.json";
    const spec = {
      openapi: "3.0.1",
      info: {
        title: "Scalar API",
        version: "v1",
      },
      paths: {
        "/api/auth/login": {
          post: {
            summary: "Login",
            responses: {
              "200": { description: "OK" },
            },
          },
        },
      },
    };

    installFetchMock({
      [docsUrl]: new Response(
        `<!doctype html><html><body><script type="module">initialize('%2Fscalar%2F',false,{"sources":[{"title":"v1","url":"swagger/v1/swagger.json"}]},'');</script></body></html>`,
        {
          status: 200,
          headers: {
            "content-type": "text/html",
          },
        },
      ),
      [specUrl]: jsonResponse(spec, specUrl),
    });

    const summary = await detectOpenApi(docsUrl);

    expect(summary.documentUrl).toBe(specUrl);
    expect(summary.apiTitle).toBe("Scalar API");
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

  it("looks up endpoint details when the input path includes a query string", async () => {
    const specUrl = "https://reports.example.com/openapi.json";
    installFetchMock({
      [specUrl]: jsonResponse(
        {
          openapi: "3.1.0",
          info: {
            title: "Reports API",
            version: "1.0.0",
          },
          paths: {
            "/reports": {
              get: {
                summary: "List reports",
                parameters: [
                  {
                    name: "period",
                    in: "query",
                    required: false,
                    schema: { type: "string" },
                  },
                ],
                responses: {
                  "200": { description: "OK" },
                },
              },
            },
          },
        },
        specUrl,
      ),
    });

    const result = await getOpenApiEndpointDetails(
      specUrl,
      "GET",
      "/reports?period=monthly",
    );

    expect(result.endpoint).toMatchObject({
      method: "GET",
      path: "/reports",
      summary: "List reports",
    });
    expect(result.endpoint.parameters[0]).toMatchObject({
      name: "period",
      in: "query",
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
