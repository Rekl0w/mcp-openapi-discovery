import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callOpenApiEndpoint } from "../src/request.js";

function jsonResponse(
  data: unknown,
  status = 200,
  headers?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json",
      ...(headers ?? {}),
    },
  });
}

describe("endpoint execution", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("acquires an OAuth password token and calls the target endpoint automatically", async () => {
    const specUrl = "https://auth.example.com/openapi.json";
    const tokenUrl = "https://auth.example.com/oauth/token";
    const endpointUrl = "https://api.example.com/me";

    const fetchMock = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;

        if (url === specUrl) {
          return jsonResponse({
            openapi: "3.1.0",
            info: {
              title: "Secure API",
              version: "1.0.0",
            },
            servers: [{ url: "https://api.example.com" }],
            paths: {
              "/me": {
                get: {
                  security: [{ OAuthPassword: [] }],
                  responses: {
                    "200": {
                      description: "ok",
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
            components: {
              securitySchemes: {
                OAuthPassword: {
                  type: "oauth2",
                  flows: {
                    password: {
                      tokenUrl,
                      scopes: {
                        profile: "Profile access",
                      },
                    },
                  },
                },
              },
            },
          });
        }

        if (url === tokenUrl) {
          expect(init?.method).toBe("POST");
          const params = init?.body as URLSearchParams;
          expect(params.get("grant_type")).toBe("password");
          expect(params.get("username")).toBe("demo");
          expect(params.get("password")).toBe("super-secret");
          expect(params.get("scope")).toBe("profile");
          const headers = new Headers(init?.headers);
          expect(headers.get("authorization")).toBe(
            `Basic ${Buffer.from("client:client-secret", "utf8").toString("base64")}`,
          );
          return jsonResponse({
            access_token: "token-123",
            token_type: "Bearer",
          });
        }

        if (url === endpointUrl) {
          const headers = new Headers(init?.headers);
          expect(headers.get("authorization")).toBe("Bearer token-123");
          return jsonResponse({
            id: 7,
            username: "demo",
          });
        }

        return new Response("Not Found", { status: 404 });
      },
    );

    vi.stubGlobal("fetch", fetchMock);

    const result = await callOpenApiEndpoint({
      url: specUrl,
      method: "GET",
      path: "/me",
      auth: {
        username: "demo",
        password: "super-secret",
        clientId: "client",
        clientSecret: "client-secret",
        scopes: ["profile"],
      },
    });

    expect(result.request.auth.applied).toHaveLength(1);
    expect(result.request.auth.applied[0]?.schemeName).toBe("OAuthPassword");
    expect(result.request.auth.tokenAcquisition).toMatchObject({
      tokenUrl,
      grantType: "password",
    });
    expect(result.request.headers.authorization).toBe("***");
    expect(result.response.status).toBe(200);
    expect(result.response.parsedAs).toBe("json");
    expect(result.response.body).toMatchObject({
      id: 7,
      username: "demo",
    });
  });

  it("sends JSON payloads with api key authentication", async () => {
    const specUrl = "https://orders.example.com/openapi.json";
    const endpointUrl = "https://orders.example.com/api/orders";

    const fetchMock = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;

        if (url === specUrl) {
          return jsonResponse({
            openapi: "3.0.3",
            info: {
              title: "Orders API",
              version: "1.0.0",
            },
            servers: [{ url: "https://orders.example.com/api" }],
            paths: {
              "/orders": {
                post: {
                  security: [{ ApiKeyAuth: [] }],
                  requestBody: {
                    required: true,
                    content: {
                      "application/json": {
                        schema: {
                          type: "object",
                        },
                      },
                    },
                  },
                  responses: {
                    "201": {
                      description: "created",
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
            components: {
              securitySchemes: {
                ApiKeyAuth: {
                  type: "apiKey",
                  in: "header",
                  name: "X-API-Key",
                },
              },
            },
          });
        }

        if (url === endpointUrl) {
          expect(init?.method).toBe("POST");
          const headers = new Headers(init?.headers);
          expect(headers.get("x-api-key")).toBe("my-key");
          expect(headers.get("content-type")).toContain("application/json");
          expect(init?.body).toBe(
            JSON.stringify({
              productId: 42,
              quantity: 3,
            }),
          );
          return jsonResponse(
            {
              success: true,
              orderId: "ord_123",
            },
            201,
          );
        }

        return new Response("Not Found", { status: 404 });
      },
    );

    vi.stubGlobal("fetch", fetchMock);

    const result = await callOpenApiEndpoint({
      url: specUrl,
      method: "POST",
      path: "/orders",
      body: {
        productId: 42,
        quantity: 3,
      },
      auth: {
        apiKey: "my-key",
      },
    });

    expect(result.request.contentType).toBe("application/json");
    expect(result.request.headers["x-api-key"]).toBe("***");
    expect(result.request.bodyPreview).toMatchObject({
      productId: 42,
      quantity: 3,
    });
    expect(result.response.status).toBe(201);
    expect(result.response.body).toMatchObject({
      success: true,
      orderId: "ord_123",
    });
  });

  it("rewrites localhost server URLs to the detected public origin for docs-generated specs", async () => {
    const specUrl = "https://public.example.com/request-docs/api?openapi=true";
    const endpointUrl = "https://public.example.com/api/maintenance-status";

    const fetchMock = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;

        if (url === specUrl) {
          return jsonResponse({
            openapi: "3.0.3",
            info: {
              title: "Laravel Request Docs",
              version: "1.0.0",
            },
            servers: [{ url: "http://localhost/api" }],
            paths: {
              "/api/maintenance-status": {
                get: {
                  responses: {
                    "200": {
                      description: "ok",
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
        }

        if (url === endpointUrl) {
          expect(init?.method).toBe("GET");
          return jsonResponse({
            maintenance: false,
          });
        }

        return new Response(`Unexpected URL: ${url}`, { status: 404 });
      },
    );

    vi.stubGlobal("fetch", fetchMock);

    const result = await callOpenApiEndpoint({
      url: specUrl,
      method: "GET",
      path: "/api/maintenance-status",
      auth: {
        strategy: "none",
      },
    });

    expect(result.request.url).toBe(endpointUrl);
    expect(result.response.status).toBe(200);
    expect(result.response.body).toMatchObject({
      maintenance: false,
    });
    expect(fetchMock).toHaveBeenCalled();
    expect(
      fetchMock.mock.calls.some((call) =>
        String(call[0]).includes("localhost"),
      ),
    ).toBe(false);
    expect(
      fetchMock.mock.calls.some((call) => String(call[0]) === endpointUrl),
    ).toBe(true);
  });
});
