import {
  getOpenApiEndpointExecutionContext,
  type EndpointExecutionContext,
  type SecuritySchemeSummary,
} from "./openapi.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const BODY_PREVIEW_LIMIT = 4_000;
const SENSITIVE_HEADER_NAMES = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
]);
const SENSITIVE_QUERY_KEYS = [
  "token",
  "access_token",
  "api_key",
  "apikey",
  "key",
];
const SENSITIVE_FIELD_PATTERN =
  /password|secret|token|authorization|api[-_]?key|client_secret/i;

type JsonObject = Record<string, unknown>;

export interface EndpointAuthInput {
  strategy?:
    | "auto"
    | "none"
    | "basic"
    | "bearer"
    | "apiKey"
    | "oauth2-password"
    | "oauth2-client-credentials";
  username?: string;
  password?: string;
  token?: string;
  apiKey?: string;
  apiKeyName?: string;
  clientId?: string;
  clientSecret?: string;
  scopes?: string[];
  tokenUrl?: string;
  tokenResponsePath?: string;
  tokenHeaders?: Record<string, unknown>;
  extraTokenParams?: Record<string, unknown>;
}

export interface CallEndpointInput {
  url: string;
  method: string;
  path: string;
  pathParams?: Record<string, unknown>;
  query?: Record<string, unknown>;
  headers?: Record<string, unknown>;
  body?: unknown;
  rawBody?: string;
  contentType?: string;
  auth?: EndpointAuthInput;
  timeoutMs?: number;
}

export interface AppliedAuthStrategy {
  schemeName?: string;
  type: string;
  detail: string;
}

export interface TokenAcquisitionSummary {
  tokenUrl: string;
  grantType: string;
}

export interface CallEndpointResult {
  discovery: EndpointExecutionContext["discovery"];
  endpoint: EndpointExecutionContext["endpoint"];
  request: {
    url: string;
    method: string;
    headers: Record<string, string>;
    contentType?: string;
    query: Record<string, unknown>;
    pathParams: Record<string, unknown>;
    bodyPreview?: unknown;
    auth: {
      applied: AppliedAuthStrategy[];
      tokenAcquisition?: TokenAcquisitionSummary;
    };
  };
  response: {
    ok: boolean;
    status: number;
    statusText: string;
    contentType?: string;
    headers: Record<string, string>;
    parsedAs: "json" | "text" | "empty";
    body: unknown;
    bodyText?: string;
  };
}

interface MutableRequestState {
  headers: Headers;
  query: URLSearchParams;
  sensitiveHeaderNames: Set<string>;
  sensitiveQueryKeys: Set<string>;
  appliedAuth: AppliedAuthStrategy[];
  tokenAcquisition?: TokenAcquisitionSummary;
}

interface AccessTokenResult {
  accessToken: string;
  tokenType: string;
  summary: TokenAcquisitionSummary;
}

export async function callOpenApiEndpoint(
  input: CallEndpointInput,
): Promise<CallEndpointResult> {
  const context = await getOpenApiEndpointExecutionContext(
    input.url,
    input.method,
    input.path,
  );
  const pathParams = input.pathParams ?? {};
  const queryInput = input.query ?? {};
  const resolvedPath = resolvePathTemplate(input.path, pathParams);
  const requestUrl = buildRequestUrl(context.baseUrl, resolvedPath, queryInput);
  const headers = normalizeHeaders(input.headers);
  const state: MutableRequestState = {
    headers,
    query: requestUrl.searchParams,
    sensitiveHeaderNames: new Set<string>(),
    sensitiveQueryKeys: new Set<string>(),
    appliedAuth: [],
  };

  await resolveAuthentication(context, input.auth, state);

  const bodyPreparation = prepareRequestBody({
    body: input.body,
    rawBody: input.rawBody,
    contentType: input.contentType,
    endpointContentTypes: context.endpoint.requestContentTypes,
  });

  if (
    bodyPreparation.contentType &&
    !bodyPreparation.omitContentTypeHeader &&
    !state.headers.has("content-type")
  ) {
    state.headers.set("content-type", bodyPreparation.contentType);
  }

  const timeoutMs = Math.max(
    1_000,
    Math.min(input.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS, 120_000),
  );
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch(requestUrl, {
      method: input.method.toUpperCase(),
      headers: state.headers,
      body: bodyPreparation.body,
      signal: controller.signal,
      redirect: "follow",
    });
  } finally {
    clearTimeout(timeout);
  }

  const parsedResponse = await parseResponse(response);

  return {
    discovery: context.discovery,
    endpoint: context.endpoint,
    request: {
      url: maskUrl(requestUrl, state.sensitiveQueryKeys),
      method: input.method.toUpperCase(),
      headers: maskHeaders(state.headers, state.sensitiveHeaderNames),
      contentType: bodyPreparation.contentType,
      query: sanitizeForOutput(queryInput) as Record<string, unknown>,
      pathParams: sanitizeForOutput(pathParams) as Record<string, unknown>,
      bodyPreview: bodyPreparation.preview,
      auth: {
        applied: state.appliedAuth,
        tokenAcquisition: state.tokenAcquisition,
      },
    },
    response: parsedResponse,
  };
}

export function formatCallEndpointResult(result: CallEndpointResult): string {
  const lines = [
    `${result.request.method} ${result.endpoint.path}`,
    `Request URL: ${result.request.url}`,
    `Response: ${result.response.status} ${result.response.statusText}`,
  ];

  if (result.request.auth.applied.length > 0) {
    lines.push(
      `Auth: ${result.request.auth.applied.map((item) => item.detail).join(" + ")}`,
    );
  } else {
    lines.push("Auth: none");
  }

  if (result.request.contentType) {
    lines.push(`Request content-type: ${result.request.contentType}`);
  }

  if (result.response.contentType) {
    lines.push(`Response content-type: ${result.response.contentType}`);
  }

  lines.push("");
  lines.push("Response body:");

  if (result.response.parsedAs === "json") {
    lines.push(JSON.stringify(result.response.body, null, 2));
  } else if (
    typeof result.response.body === "string" &&
    result.response.body.length > 0
  ) {
    lines.push(result.response.body);
  } else {
    lines.push("(empty response body)");
  }

  return lines.join("\n");
}

async function resolveAuthentication(
  context: EndpointExecutionContext,
  auth: EndpointAuthInput | undefined,
  state: MutableRequestState,
): Promise<void> {
  const strategy = auth?.strategy ?? "auto";
  if (strategy === "none") {
    return;
  }

  if (strategy !== "auto") {
    await applyExplicitStrategy(context, auth, strategy, state);
    return;
  }

  const requirements = prioritizeRequirements(
    context.securityRequirements,
    Boolean(auth),
  );
  for (const requirement of requirements) {
    if (requirement.length === 0) {
      if (!auth) {
        return;
      }
      continue;
    }

    const draftState = cloneState(state);
    let satisfied = true;

    for (const requirementName of requirement) {
      const scheme = context.securitySchemes.find(
        (item) => item.name === requirementName,
      );
      if (!scheme) {
        satisfied = false;
        break;
      }

      try {
        await applyScheme(scheme, auth, draftState);
      } catch {
        satisfied = false;
        break;
      }
    }

    if (satisfied) {
      state.headers = draftState.headers;
      state.query = draftState.query;
      state.sensitiveHeaderNames = draftState.sensitiveHeaderNames;
      state.sensitiveQueryKeys = draftState.sensitiveQueryKeys;
      state.appliedAuth = draftState.appliedAuth;
      state.tokenAcquisition = draftState.tokenAcquisition;
      return;
    }
  }

  if (auth) {
    const fallbackScheme =
      context.securitySchemes.find((item) => isBearerLike(item)) ??
      context.securitySchemes.find((item) => item.type === "apiKey") ??
      context.securitySchemes.find(
        (item) =>
          item.type === "http" && item.scheme?.toLowerCase() === "basic",
      );

    if (fallbackScheme) {
      await applyScheme(fallbackScheme, auth, state);
      return;
    }

    if (auth.token) {
      applyBearerHeader(state, auth.token, "Bearer", undefined, "Bearer token");
      return;
    }
  }

  if (
    context.securityRequirements.some((requirement) => requirement.length > 0)
  ) {
    throw new Error(
      "Endpoint authentication could not be satisfied with the provided credentials.",
    );
  }
}

async function applyExplicitStrategy(
  context: EndpointExecutionContext,
  auth: EndpointAuthInput | undefined,
  strategy: NonNullable<EndpointAuthInput["strategy"]>,
  state: MutableRequestState,
): Promise<void> {
  switch (strategy) {
    case "basic": {
      const scheme =
        context.securitySchemes.find(
          (item) =>
            item.type === "http" && item.scheme?.toLowerCase() === "basic",
        ) ??
        ({
          name: "basic",
          type: "http",
          scheme: "basic",
        } satisfies SecuritySchemeSummary);
      await applyScheme(scheme, auth, state);
      return;
    }

    case "bearer": {
      const scheme =
        context.securitySchemes.find((item) => isBearerLike(item)) ??
        ({
          name: "bearer",
          type: "http",
          scheme: "bearer",
        } satisfies SecuritySchemeSummary);
      await applyScheme(scheme, auth, state);
      return;
    }

    case "apiKey": {
      const scheme =
        context.securitySchemes.find((item) => item.type === "apiKey") ??
        ({
          name: auth?.apiKeyName ?? "apiKey",
          type: "apiKey",
          in: "header",
          parameterName: auth?.apiKeyName ?? "X-API-Key",
        } satisfies SecuritySchemeSummary);
      await applyScheme(scheme, auth, state);
      return;
    }

    case "oauth2-password": {
      const scheme =
        context.securitySchemes.find(
          (item) =>
            item.type === "oauth2" ||
            item.type === "openIdConnect" ||
            isBearerLike(item),
        ) ??
        ({
          name: "oauth2-password",
          type: "oauth2",
        } satisfies SecuritySchemeSummary);
      await applyScheme(scheme, { ...auth, strategy }, state);
      return;
    }

    case "oauth2-client-credentials": {
      const scheme =
        context.securitySchemes.find(
          (item) =>
            item.type === "oauth2" ||
            item.type === "openIdConnect" ||
            isBearerLike(item),
        ) ??
        ({
          name: "oauth2-client-credentials",
          type: "oauth2",
        } satisfies SecuritySchemeSummary);
      await applyScheme(scheme, { ...auth, strategy }, state);
      return;
    }

    default:
      return;
  }
}

async function applyScheme(
  scheme: SecuritySchemeSummary,
  auth: EndpointAuthInput | undefined,
  state: MutableRequestState,
): Promise<void> {
  switch (scheme.type) {
    case "http": {
      const httpScheme = scheme.scheme?.toLowerCase();
      if (httpScheme === "basic") {
        requireCredentials(
          auth?.username,
          auth?.password,
          "Basic authentication requires username and password.",
        );
        const encoded = Buffer.from(
          `${auth?.username}:${auth?.password}`,
          "utf8",
        ).toString("base64");
        state.headers.set("authorization", `Basic ${encoded}`);
        state.sensitiveHeaderNames.add("authorization");
        state.appliedAuth.push({
          schemeName: scheme.name,
          type: "http",
          detail: scheme.name === "basic" ? "basic" : `${scheme.name} (basic)`,
        });
        return;
      }

      if (httpScheme === "bearer") {
        const token = await resolveBearerToken(scheme, auth);
        applyBearerHeader(
          state,
          token.accessToken,
          token.tokenType,
          scheme.name,
          `${scheme.name} (bearer)`,
        );
        if (token.summary) {
          state.tokenAcquisition = token.summary;
        }
        return;
      }

      throw new Error(
        `Unsupported HTTP auth scheme: ${scheme.scheme ?? "unknown"}`,
      );
    }

    case "apiKey": {
      const apiKeyValue = auth?.apiKey ?? auth?.token;
      if (!apiKeyValue) {
        throw new Error(
          `API key auth for ${scheme.name} requires auth.apiKey or auth.token.`,
        );
      }

      const location = scheme.in ?? "header";
      const parameterName = auth?.apiKeyName ?? scheme.parameterName;
      if (!parameterName) {
        throw new Error(
          `API key auth for ${scheme.name} needs a parameter name.`,
        );
      }

      if (location === "query") {
        state.query.set(parameterName, apiKeyValue);
        state.sensitiveQueryKeys.add(parameterName.toLowerCase());
      } else if (location === "cookie") {
        const existing = state.headers.get("cookie");
        const value = `${parameterName}=${apiKeyValue}`;
        state.headers.set("cookie", existing ? `${existing}; ${value}` : value);
        state.sensitiveHeaderNames.add("cookie");
      } else {
        state.headers.set(parameterName, apiKeyValue);
        state.sensitiveHeaderNames.add(parameterName.toLowerCase());
      }

      state.appliedAuth.push({
        schemeName: scheme.name,
        type: "apiKey",
        detail: `${scheme.name} (apiKey:${location})`,
      });
      return;
    }

    case "oauth2":
    case "openIdConnect": {
      const token = await resolveBearerToken(scheme, auth);
      applyBearerHeader(
        state,
        token.accessToken,
        token.tokenType,
        scheme.name,
        `${scheme.name} (${scheme.type})`,
      );
      state.tokenAcquisition = token.summary;
      return;
    }

    case "mutualTLS":
      throw new Error(
        "mutualTLS auth cannot be automated through this MCP tool yet.",
      );

    default:
      throw new Error(`Unsupported security scheme type: ${scheme.type}`);
  }
}

function applyBearerHeader(
  state: MutableRequestState,
  token: string,
  tokenType: string,
  schemeName: string | undefined,
  detail: string,
): void {
  state.headers.set("authorization", `${tokenType || "Bearer"} ${token}`);
  state.sensitiveHeaderNames.add("authorization");
  state.appliedAuth.push({
    schemeName,
    type: "bearer",
    detail,
  });
}

async function resolveBearerToken(
  scheme: SecuritySchemeSummary,
  auth: EndpointAuthInput | undefined,
): Promise<AccessTokenResult> {
  if (auth?.token) {
    return {
      accessToken: auth.token,
      tokenType: "Bearer",
      summary: {
        tokenUrl:
          auth.tokenUrl ??
          scheme.openIdConnectUrl ??
          scheme.oauth2MetadataUrl ??
          "provided-directly",
        grantType: "provided_token",
      },
    };
  }

  const acquisition = await acquireAccessToken(scheme, auth);
  return acquisition;
}

async function acquireAccessToken(
  scheme: SecuritySchemeSummary,
  auth: EndpointAuthInput | undefined,
): Promise<AccessTokenResult> {
  if (!auth) {
    throw new Error(`No credentials provided for ${scheme.name}.`);
  }

  const explicitStrategy =
    auth.strategy === "oauth2-password" ||
    auth.strategy === "oauth2-client-credentials"
      ? auth.strategy
      : undefined;
  const grantType = pickGrantType(scheme, auth, explicitStrategy);
  const tokenUrl = await resolveTokenUrl(scheme, auth, grantType);

  const tokenHeaders = normalizeHeaders(auth.tokenHeaders);
  tokenHeaders.set("accept", "application/json");
  tokenHeaders.set("content-type", "application/x-www-form-urlencoded");

  const params = new URLSearchParams();
  params.set("grant_type", grantType);

  if (grantType === "password") {
    requireCredentials(
      auth.username,
      auth.password,
      "Password flow requires username and password.",
    );
    params.set("username", auth.username as string);
    params.set("password", auth.password as string);
  }

  if (auth.scopes && auth.scopes.length > 0) {
    params.set("scope", auth.scopes.join(" "));
  }

  if (auth.clientId && auth.clientSecret) {
    const encoded = Buffer.from(
      `${auth.clientId}:${auth.clientSecret}`,
      "utf8",
    ).toString("base64");
    tokenHeaders.set("authorization", `Basic ${encoded}`);
  } else {
    if (auth.clientId) {
      params.set("client_id", auth.clientId);
    }
    if (auth.clientSecret) {
      params.set("client_secret", auth.clientSecret);
    }
  }

  for (const [key, value] of Object.entries(auth.extraTokenParams ?? {})) {
    if (value !== undefined && value !== null) {
      params.set(key, String(value));
    }
  }

  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: tokenHeaders,
    body: params,
  });

  const text = await response.text();
  const parsed = tryParseJson(text);
  if (!response.ok) {
    throw new Error(
      `Token request failed (${response.status} ${response.statusText}): ${truncate(text, 500)}`,
    );
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error("Token endpoint returned a non-JSON response.");
  }

  const accessToken = readPathValue(
    parsed,
    auth.tokenResponsePath ?? "access_token",
  );
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw new Error("Token endpoint response does not contain access_token.");
  }

  const tokenType = readPathValue(parsed, "token_type");

  return {
    accessToken,
    tokenType:
      typeof tokenType === "string" && tokenType.length > 0
        ? tokenType
        : "Bearer",
    summary: {
      tokenUrl,
      grantType,
    },
  };
}

async function resolveTokenUrl(
  scheme: SecuritySchemeSummary,
  auth: EndpointAuthInput,
  grantType: string,
): Promise<string> {
  if (auth.tokenUrl) {
    return auth.tokenUrl;
  }

  if (scheme.type === "oauth2" && scheme.flows) {
    const flow =
      grantType === "password"
        ? scheme.flows.password
        : scheme.flows.clientCredentials;
    if (flow?.tokenUrl) {
      return flow.tokenUrl;
    }
  }

  if (scheme.oauth2MetadataUrl) {
    const tokenUrl = await readTokenUrlFromMetadata(scheme.oauth2MetadataUrl);
    if (tokenUrl) {
      return tokenUrl;
    }
  }

  if (scheme.openIdConnectUrl) {
    const tokenUrl = await readTokenUrlFromMetadata(scheme.openIdConnectUrl);
    if (tokenUrl) {
      return tokenUrl;
    }
  }

  throw new Error(
    `Token URL could not be determined for ${scheme.name}. Provide auth.tokenUrl explicitly.`,
  );
}

async function readTokenUrlFromMetadata(
  metadataUrl: string,
): Promise<string | undefined> {
  const response = await fetch(metadataUrl, {
    method: "GET",
    headers: {
      accept: "application/json",
    },
  });

  if (!response.ok) {
    return undefined;
  }

  const text = await response.text();
  const parsed = tryParseJson(text);
  return parsed && typeof parsed.token_endpoint === "string"
    ? parsed.token_endpoint
    : undefined;
}

function pickGrantType(
  scheme: SecuritySchemeSummary,
  auth: EndpointAuthInput,
  explicitStrategy: "oauth2-password" | "oauth2-client-credentials" | undefined,
): "password" | "client_credentials" {
  if (explicitStrategy === "oauth2-password") {
    requireCredentials(
      auth.username,
      auth.password,
      "Password flow requires username and password.",
    );
    return "password";
  }

  if (explicitStrategy === "oauth2-client-credentials") {
    requireCredentials(
      auth.clientId,
      auth.clientSecret,
      "Client credentials flow requires clientId and clientSecret.",
    );
    return "client_credentials";
  }

  if (auth.username && auth.password) {
    if (
      scheme.flows?.password?.tokenUrl ||
      auth.tokenUrl ||
      scheme.type === "openIdConnect" ||
      Boolean(scheme.oauth2MetadataUrl)
    ) {
      return "password";
    }
  }

  if (auth.clientId && auth.clientSecret) {
    if (
      scheme.flows?.clientCredentials?.tokenUrl ||
      auth.tokenUrl ||
      scheme.type === "openIdConnect" ||
      Boolean(scheme.oauth2MetadataUrl)
    ) {
      return "client_credentials";
    }
  }

  throw new Error(
    `Could not infer an OAuth grant type for ${scheme.name}. Provide matching credentials or set auth.strategy explicitly.`,
  );
}

function prepareRequestBody(input: {
  body: unknown;
  rawBody?: string;
  contentType?: string;
  endpointContentTypes: string[];
}): {
  body: BodyInit | undefined;
  contentType?: string;
  preview?: unknown;
  omitContentTypeHeader?: boolean;
} {
  const contentType =
    input.contentType ??
    chooseContentType(input.endpointContentTypes, input.rawBody, input.body);

  if (typeof input.rawBody === "string") {
    return {
      body: input.rawBody,
      contentType,
      preview: truncate(input.rawBody, BODY_PREVIEW_LIMIT),
    };
  }

  if (input.body === undefined) {
    return {
      body: undefined,
      contentType,
    };
  }

  if (contentType?.includes("application/x-www-form-urlencoded")) {
    const params = new URLSearchParams();
    appendQueryValues(params, input.body as Record<string, unknown>);
    return {
      body: params,
      contentType,
      preview: sanitizeForOutput(input.body),
    };
  }

  if (contentType?.includes("multipart/form-data")) {
    const formData = new FormData();
    appendFormData(formData, input.body as Record<string, unknown>);
    return {
      body: formData,
      contentType: undefined,
      omitContentTypeHeader: true,
      preview: sanitizeForOutput(input.body),
    };
  }

  if (contentType?.startsWith("text/") && typeof input.body === "string") {
    return {
      body: input.body,
      contentType,
      preview: truncate(input.body, BODY_PREVIEW_LIMIT),
    };
  }

  const serialized =
    typeof input.body === "string" ? input.body : JSON.stringify(input.body);
  return {
    body: serialized,
    contentType: contentType ?? "application/json",
    preview: sanitizeForOutput(input.body),
  };
}

function chooseContentType(
  endpointContentTypes: string[],
  rawBody: string | undefined,
  body: unknown,
): string | undefined {
  if (endpointContentTypes.length > 0) {
    if (endpointContentTypes.includes("application/json")) {
      return "application/json";
    }
    return endpointContentTypes[0];
  }

  if (typeof rawBody === "string") {
    return "text/plain";
  }

  if (body !== undefined) {
    return "application/json";
  }

  return undefined;
}

async function parseResponse(
  response: Response,
): Promise<CallEndpointResult["response"]> {
  const contentType = response.headers.get("content-type") ?? undefined;
  const text = await response.text();
  const parsedJson = contentType?.includes("json")
    ? tryParseJson(text)
    : undefined;
  const parsedAs =
    parsedJson !== undefined ? "json" : text.length > 0 ? "text" : "empty";

  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    contentType,
    headers: headersToObject(response.headers),
    parsedAs,
    body: parsedJson !== undefined ? parsedJson : text,
    bodyText: parsedJson === undefined && text.length > 0 ? text : undefined,
  };
}

function resolvePathTemplate(
  path: string,
  pathParams: Record<string, unknown>,
): string {
  return path.replace(/\{([^}]+)\}/g, (_fullMatch, key: string) => {
    if (!(key in pathParams)) {
      throw new Error(`Missing required path parameter: ${key}`);
    }
    return encodeURIComponent(String(pathParams[key]));
  });
}

function buildRequestUrl(
  baseUrl: string,
  resolvedPath: string,
  query: Record<string, unknown>,
): URL {
  const url = new URL(baseUrl);
  const basePath = url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "");
  url.pathname = `${basePath}${resolvedPath.startsWith("/") ? resolvedPath : `/${resolvedPath}`}`;
  url.search = "";
  url.hash = "";
  appendQueryValues(url.searchParams, query);
  return url;
}

function appendQueryValues(
  target: URLSearchParams,
  value: Record<string, unknown>,
): void {
  for (const [key, rawValue] of Object.entries(value ?? {})) {
    if (rawValue === undefined || rawValue === null) {
      continue;
    }

    if (Array.isArray(rawValue)) {
      for (const item of rawValue) {
        if (item !== undefined && item !== null) {
          target.append(key, String(item));
        }
      }
      continue;
    }

    if (typeof rawValue === "object") {
      target.append(key, JSON.stringify(rawValue));
      continue;
    }

    target.append(key, String(rawValue));
  }
}

function appendFormData(
  target: FormData,
  value: Record<string, unknown>,
): void {
  for (const [key, rawValue] of Object.entries(value ?? {})) {
    if (rawValue === undefined || rawValue === null) {
      continue;
    }

    if (Array.isArray(rawValue)) {
      for (const item of rawValue) {
        target.append(
          key,
          item instanceof Blob
            ? item
            : typeof item === "object"
              ? JSON.stringify(item)
              : String(item),
        );
      }
      continue;
    }

    target.append(
      key,
      rawValue instanceof Blob
        ? rawValue
        : typeof rawValue === "object"
          ? JSON.stringify(rawValue)
          : String(rawValue),
    );
  }
}

function normalizeHeaders(
  headers: Record<string, unknown> | undefined,
): Headers {
  const normalized = new Headers();
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (value === undefined || value === null) {
      continue;
    }
    normalized.set(key, String(value));
  }
  return normalized;
}

function cloneState(state: MutableRequestState): MutableRequestState {
  return {
    headers: new Headers(state.headers),
    query: new URLSearchParams(state.query),
    sensitiveHeaderNames: new Set(state.sensitiveHeaderNames),
    sensitiveQueryKeys: new Set(state.sensitiveQueryKeys),
    appliedAuth: [...state.appliedAuth],
    tokenAcquisition: state.tokenAcquisition
      ? { ...state.tokenAcquisition }
      : undefined,
  };
}

function prioritizeRequirements(
  requirements: string[][],
  hasAuthInput: boolean,
): string[][] {
  const empty = requirements.filter((item) => item.length === 0);
  const nonEmpty = requirements.filter((item) => item.length > 0);
  return hasAuthInput ? [...nonEmpty, ...empty] : [...empty, ...nonEmpty];
}

function isBearerLike(scheme: SecuritySchemeSummary): boolean {
  return (
    (scheme.type === "http" && scheme.scheme?.toLowerCase() === "bearer") ||
    scheme.type === "oauth2" ||
    scheme.type === "openIdConnect"
  );
}

function headersToObject(headers: Headers): Record<string, string> {
  const object: Record<string, string> = {};
  headers.forEach((value, key) => {
    object[key] = value;
  });
  return object;
}

function maskHeaders(
  headers: Headers,
  sensitiveHeaderNames: Set<string>,
): Record<string, string> {
  const masked: Record<string, string> = {};
  headers.forEach((value, key) => {
    masked[key] =
      SENSITIVE_HEADER_NAMES.has(key.toLowerCase()) ||
      sensitiveHeaderNames.has(key.toLowerCase())
        ? "***"
        : value;
  });
  return masked;
}

function maskUrl(url: URL, sensitiveQueryKeys: Set<string>): string {
  const masked = new URL(url.toString());
  for (const [key] of masked.searchParams) {
    if (
      sensitiveQueryKeys.has(key.toLowerCase()) ||
      SENSITIVE_QUERY_KEYS.includes(key.toLowerCase())
    ) {
      masked.searchParams.set(key, "***");
    }
  }
  return masked.toString();
}

function sanitizeForOutput(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeForOutput(item));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as JsonObject).map(([key, item]) => [
        key,
        SENSITIVE_FIELD_PATTERN.test(key) ? "***" : sanitizeForOutput(item),
      ]),
    );
  }

  if (typeof value === "string") {
    return truncate(value, BODY_PREVIEW_LIMIT);
  }

  return value;
}

function readPathValue(value: unknown, path: string): unknown {
  const segments = path.split(".").filter(Boolean);
  let current = value;
  for (const segment of segments) {
    if (
      !current ||
      typeof current !== "object" ||
      !(segment in (current as JsonObject))
    ) {
      return undefined;
    }
    current = (current as JsonObject)[segment];
  }
  return current;
}

function tryParseJson(text: string): JsonObject | undefined {
  if (!text.trim()) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object"
      ? (parsed as JsonObject)
      : undefined;
  } catch {
    return undefined;
  }
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value;
}

function requireCredentials(
  left: string | undefined,
  right: string | undefined,
  message: string,
): void {
  if (!left || !right) {
    throw new Error(message);
  }
}
