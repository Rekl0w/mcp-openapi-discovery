import { parse as parseYaml } from "yaml";

type JsonObject = Record<string, unknown>;

export const HTTP_METHODS = [
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace",
] as const;

export type HttpMethod = (typeof HTTP_METHODS)[number];

const COMMON_SPEC_PATHS = [
  "openapi.json",
  "openapi.yaml",
  "openapi.yml",
  "swagger.json",
  "swagger.yaml",
  "swagger.yml",
  "api-docs",
  "api-docs.json",
  "api/openapi.json",
  "api/openapi.yaml",
  "api/swagger.json",
  "docs/openapi.json",
  "docs/openapi.yaml",
  "docs/swagger.json",
  "docs/swagger.yaml",
  "openapi",
  "swagger",
] as const;

const ACCEPT_HEADER = [
  "application/openapi+json",
  "application/json",
  "application/yaml",
  "text/yaml",
  "text/plain",
  "text/html;q=0.9",
].join(", ");

const USER_AGENT = "mcp-openapi-discovery/0.1.0";
const FETCH_TIMEOUT_MS = 10_000;
const MAX_CANDIDATES = 30;
const MAX_SCHEMA_PROPERTIES = 12;

export interface DiscoverySummary {
  inputUrl: string;
  documentUrl: string;
  pageUrl?: string;
  source: "direct" | "common-path" | "html-link" | "inline-html";
  format: "json" | "yaml";
  openapiVersion: string;
  apiTitle: string;
  apiVersion?: string;
  servers: string[];
  tags: string[];
  endpointCount: number;
  discoveryTrail: string[];
}

export interface SchemaDescriptor {
  ref?: string;
  refName?: string;
  type?: string | string[];
  format?: string;
  description?: string;
  nullable?: boolean;
  enumValues?: unknown[];
  propertyKeys?: string[];
  requiredProperties?: string[];
  itemType?: string | string[];
  arrayItemRef?: string;
  contentMediaType?: string;
  contentEncoding?: string;
  combinators?: {
    oneOf?: number;
    anyOf?: number;
    allOf?: number;
  };
}

export interface ParameterSummary {
  name: string;
  in: string;
  required: boolean;
  description?: string;
  deprecated?: boolean;
  schema?: SchemaDescriptor;
}

export interface RequestBodySummary {
  required: boolean;
  contentTypes: string[];
  entries: Array<{
    contentType: string;
    schema?: SchemaDescriptor;
  }>;
}

export interface ResponseSummary {
  status: string;
  description?: string;
  contentTypes: string[];
  entries: Array<{
    contentType: string;
    schema?: SchemaDescriptor;
  }>;
}

export interface EndpointSummary {
  method: Uppercase<HttpMethod>;
  path: string;
  operationId?: string;
  summary?: string;
  description?: string;
  tags: string[];
  deprecated: boolean;
  requestContentTypes: string[];
  responseCodes: string[];
}

export interface EndpointDetail extends EndpointSummary {
  servers: string[];
  security: string[];
  parameters: ParameterSummary[];
  requestBody?: RequestBodySummary;
  responses: ResponseSummary[];
}

export interface OAuthFlowSummary {
  authorizationUrl?: string;
  deviceAuthorizationUrl?: string;
  tokenUrl?: string;
  refreshUrl?: string;
  scopes: string[];
}

export interface SecuritySchemeSummary {
  name: string;
  type: string;
  description?: string;
  scheme?: string;
  bearerFormat?: string;
  in?: string;
  parameterName?: string;
  openIdConnectUrl?: string;
  oauth2MetadataUrl?: string;
  flows?: Partial<
    Record<
      | "implicit"
      | "password"
      | "clientCredentials"
      | "authorizationCode"
      | "deviceAuthorization",
      OAuthFlowSummary
    >
  >;
}

export interface EndpointExecutionContext {
  discovery: DiscoverySummary;
  endpoint: EndpointDetail;
  baseUrl: string;
  securityRequirements: string[][];
  securitySchemes: SecuritySchemeSummary[];
}

export interface ParameterUsageMatch {
  method: Uppercase<HttpMethod>;
  path: string;
  operationId?: string;
  summary?: string;
  tags: string[];
  location:
    | "path-parameter"
    | "query-parameter"
    | "header-parameter"
    | "cookie-parameter"
    | "request-body"
    | "response-body";
  fieldName: string;
  fieldPath?: string;
  schemaRef?: string;
  matchedBy: "exact" | "normalized" | "entity-id-heuristic";
  reason: string;
}

export interface RelatedEndpointMatch {
  method: Uppercase<HttpMethod>;
  path: string;
  operationId?: string;
  summary?: string;
  tags: string[];
  score: number;
  reasons: string[];
}

interface CandidateUrl {
  url: string;
  source: DiscoverySummary["source"];
  trail: string[];
  pageUrl?: string;
}

interface FetchedPage {
  ok: boolean;
  status: number;
  contentType: string;
  body: string;
  finalUrl: string;
}

interface ParseSuccess {
  format: "json" | "yaml";
  doc: OpenApiDocument;
}

interface ResolvedDocument {
  discovery: DiscoverySummary;
  document: OpenApiDocument;
}

type OpenApiDocument = JsonObject & {
  openapi?: string;
  swagger?: string;
  info?: JsonObject;
  paths?: Record<string, unknown>;
  tags?: Array<JsonObject>;
  servers?: Array<JsonObject>;
  security?: Array<Record<string, unknown>>;
  consumes?: string[];
  produces?: string[];
};

const documentCache = new Map<string, Promise<ResolvedDocument>>();

export async function detectOpenApi(url: string): Promise<DiscoverySummary> {
  const resolved = await loadResolvedDocument(url);
  return resolved.discovery;
}

export async function listOpenApiEndpoints(
  url: string,
  filters: {
    tag?: string;
    method?: string;
    pathContains?: string;
    includeDeprecated?: boolean;
    limit?: number;
  } = {},
): Promise<{
  discovery: DiscoverySummary;
  totalEndpoints: number;
  matchedEndpoints: number;
  endpoints: EndpointSummary[];
}> {
  const resolved = await loadResolvedDocument(url);
  const endpoints = extractEndpoints(resolved.document);
  const normalizedMethod = normalizeMethod(filters.method);
  const tagFilter = filters.tag?.trim().toLowerCase();
  const pathFilter = filters.pathContains?.trim().toLowerCase();
  const includeDeprecated = filters.includeDeprecated ?? true;

  const filtered = endpoints.filter((endpoint) => {
    if (normalizedMethod && endpoint.method !== normalizedMethod) {
      return false;
    }

    if (!includeDeprecated && endpoint.deprecated) {
      return false;
    }

    if (
      tagFilter &&
      !endpoint.tags.some((tag) => tag.toLowerCase().includes(tagFilter))
    ) {
      return false;
    }

    if (pathFilter) {
      const haystack =
        `${endpoint.path} ${endpoint.summary ?? ""} ${endpoint.description ?? ""}`.toLowerCase();
      if (!haystack.includes(pathFilter)) {
        return false;
      }
    }

    return true;
  });

  const limit = Math.max(1, Math.min(filters.limit ?? 50, 200));

  return {
    discovery: resolved.discovery,
    totalEndpoints: endpoints.length,
    matchedEndpoints: filtered.length,
    endpoints: filtered.slice(0, limit),
  };
}

export async function getOpenApiEndpointDetails(
  url: string,
  method: string,
  path: string,
): Promise<{
  discovery: DiscoverySummary;
  endpoint: EndpointDetail;
}> {
  const resolved = await loadResolvedDocument(url);
  const normalizedMethod = normalizeMethod(method);

  if (!normalizedMethod) {
    throw new Error(`Unsupported HTTP method: ${method}`);
  }

  const endpoint = extractEndpointDetail(
    resolved.document,
    normalizedMethod,
    path,
    resolved.discovery.documentUrl,
  );

  if (!endpoint) {
    throw new Error(`Endpoint not found for ${normalizedMethod} ${path}`);
  }

  return {
    discovery: resolved.discovery,
    endpoint,
  };
}

export async function getOpenApiEndpointExecutionContext(
  url: string,
  method: string,
  path: string,
): Promise<EndpointExecutionContext> {
  const resolved = await loadResolvedDocument(url);
  const normalizedMethod = normalizeMethod(method);

  if (!normalizedMethod) {
    throw new Error(`Unsupported HTTP method: ${method}`);
  }

  const operationContext = getOperationContext(
    resolved.document,
    normalizedMethod,
    path,
    resolved.discovery.documentUrl,
  );

  if (!operationContext) {
    throw new Error(`Endpoint not found for ${normalizedMethod} ${path}`);
  }

  return {
    discovery: resolved.discovery,
    endpoint: operationContext.endpoint,
    baseUrl:
      operationContext.endpoint.servers[0] ??
      new URL("/", resolved.discovery.documentUrl).toString(),
    securityRequirements: operationContext.securityRequirements,
    securitySchemes: operationContext.securitySchemes,
  };
}

export async function traceParameterUsage(
  url: string,
  parameterName: string,
  options: {
    entityName?: string;
    method?: string;
    path?: string;
    includeRequestBodies?: boolean;
    includeResponseBodies?: boolean;
    limit?: number;
  } = {},
): Promise<{
  discovery: DiscoverySummary;
  search: {
    parameterName: string;
    entityName?: string;
  };
  totalMatches: number;
  matches: ParameterUsageMatch[];
}> {
  const resolved = await loadResolvedDocument(url);
  const normalizedMethod = normalizeMethod(options.method);
  const matches: ParameterUsageMatch[] = [];
  const includeRequestBodies = options.includeRequestBodies ?? true;
  const includeResponseBodies = options.includeResponseBodies ?? true;
  const searchNeedles = buildParameterNeedles(
    parameterName,
    options.entityName,
  );
  const paths = isObject(resolved.document.paths)
    ? resolved.document.paths
    : {};

  for (const [path, pathItem] of Object.entries(paths)) {
    if (!isObject(pathItem)) {
      continue;
    }

    if (options.path && path !== options.path) {
      continue;
    }

    for (const method of HTTP_METHODS) {
      const operation = pathItem[method];
      if (!isObject(operation)) {
        continue;
      }

      const upperMethod = method.toUpperCase() as Uppercase<HttpMethod>;
      if (normalizedMethod && upperMethod !== normalizedMethod) {
        continue;
      }

      const endpoint = getOperationContext(
        resolved.document,
        upperMethod,
        path,
        resolved.discovery.documentUrl,
      )?.endpoint;
      if (!endpoint) {
        continue;
      }

      for (const parameter of endpoint.parameters) {
        const fieldPath = parameter.name;
        const match = matchFieldCandidate({
          fieldName: parameter.name,
          fieldPath,
          path,
          endpoint,
          searchNeedles,
        });

        if (!match) {
          continue;
        }

        const locationMap: Record<string, ParameterUsageMatch["location"]> = {
          path: "path-parameter",
          query: "query-parameter",
          header: "header-parameter",
          cookie: "cookie-parameter",
        };

        matches.push({
          method: endpoint.method,
          path: endpoint.path,
          operationId: endpoint.operationId,
          summary: endpoint.summary,
          tags: endpoint.tags,
          location: locationMap[parameter.in] ?? "query-parameter",
          fieldName: parameter.name,
          fieldPath,
          schemaRef: parameter.schema?.refName ?? parameter.schema?.ref,
          matchedBy: match.matchedBy,
          reason: match.reason,
        });
      }

      if (includeRequestBodies) {
        const requestBodyMatches = collectBodyFieldMatches({
          doc: resolved.document,
          endpoint,
          body: endpoint.requestBody,
          location: "request-body",
          searchNeedles,
          originalOperation: operation,
          originalPathItem: pathItem,
          includeResponses: false,
        });
        matches.push(...requestBodyMatches);
      }

      if (includeResponseBodies) {
        const responseMatches = collectResponseFieldMatches({
          doc: resolved.document,
          endpoint,
          responses: endpoint.responses,
          operation,
          pathItem,
          searchNeedles,
        });
        matches.push(...responseMatches);
      }
    }
  }

  const deduped = dedupeParameterMatches(matches).sort(
    (left, right) =>
      left.path.localeCompare(right.path) ||
      left.method.localeCompare(right.method) ||
      left.location.localeCompare(right.location),
  );
  const limit = Math.max(1, Math.min(options.limit ?? 100, 300));

  return {
    discovery: resolved.discovery,
    search: {
      parameterName,
      entityName: options.entityName,
    },
    totalMatches: deduped.length,
    matches: deduped.slice(0, limit),
  };
}

export async function findRelatedEndpoints(
  url: string,
  method: string,
  path: string,
  options: {
    limit?: number;
  } = {},
): Promise<{
  discovery: DiscoverySummary;
  source: EndpointDetail;
  relatedEndpoints: RelatedEndpointMatch[];
}> {
  const resolved = await loadResolvedDocument(url);
  const normalizedMethod = normalizeMethod(method);

  if (!normalizedMethod) {
    throw new Error(`Unsupported HTTP method: ${method}`);
  }

  const sourceContext = getOperationContext(
    resolved.document,
    normalizedMethod,
    path,
    resolved.discovery.documentUrl,
  );
  if (!sourceContext) {
    throw new Error(`Endpoint not found for ${normalizedMethod} ${path}`);
  }

  const source = sourceContext.endpoint;
  const sourceSignals = extractEndpointSignals(source);
  const related: RelatedEndpointMatch[] = [];
  const paths = isObject(resolved.document.paths)
    ? resolved.document.paths
    : {};

  for (const [candidatePath, pathItem] of Object.entries(paths)) {
    if (!isObject(pathItem)) {
      continue;
    }

    for (const candidateMethod of HTTP_METHODS) {
      const operation = pathItem[candidateMethod];
      if (!isObject(operation)) {
        continue;
      }

      const upperMethod =
        candidateMethod.toUpperCase() as Uppercase<HttpMethod>;
      if (upperMethod === source.method && candidatePath === source.path) {
        continue;
      }

      const context = getOperationContext(
        resolved.document,
        upperMethod,
        candidatePath,
        resolved.discovery.documentUrl,
      );
      if (!context) {
        continue;
      }

      const candidate = context.endpoint;
      const candidateSignals = extractEndpointSignals(candidate);
      const reasons: string[] = [];
      let score = 0;

      const sharedTags = intersect(source.tags, candidate.tags);
      if (sharedTags.length > 0) {
        score += sharedTags.length * 2;
        reasons.push(`shared tags: ${sharedTags.join(", ")}`);
      }

      const sharedResources = intersect(
        sourceSignals.resourceTokens,
        candidateSignals.resourceTokens,
      );
      if (sharedResources.length > 0) {
        score += sharedResources.length * 3;
        reasons.push(`shared resources: ${sharedResources.join(", ")}`);
      }

      const sharedIdentifiers = intersect(
        sourceSignals.identifiers,
        candidateSignals.identifiers,
      );
      if (sharedIdentifiers.length > 0) {
        score += sharedIdentifiers.length * 4;
        reasons.push(`shared identifiers: ${sharedIdentifiers.join(", ")}`);
      }

      const heuristicEntities = intersect(
        sourceSignals.entityIdEntities,
        candidateSignals.resourceTokens,
      );
      if (
        heuristicEntities.length > 0 &&
        (candidateSignals.identifiers.includes("id") ||
          candidateSignals.identifiers.includes("uuid"))
      ) {
        score += heuristicEntities.length * 4;
        reasons.push(
          `entity/id heuristic via: ${heuristicEntities.join(", ")}`,
        );
      }

      if (isPathRelated(source.path, candidate.path)) {
        score += 2;
        reasons.push("parent/child path relationship");
      }

      if (score <= 0) {
        continue;
      }

      related.push({
        method: candidate.method,
        path: candidate.path,
        operationId: candidate.operationId,
        summary: candidate.summary,
        tags: candidate.tags,
        score,
        reasons,
      });
    }
  }

  const limit = Math.max(1, Math.min(options.limit ?? 20, 100));
  const sorted = related.sort(
    (left, right) =>
      right.score - left.score ||
      left.path.localeCompare(right.path) ||
      left.method.localeCompare(right.method),
  );

  return {
    discovery: resolved.discovery,
    source,
    relatedEndpoints: sorted.slice(0, limit),
  };
}

export function formatDiscoverySummary(summary: DiscoverySummary): string {
  const lines = [
    `API: ${summary.apiTitle}${summary.apiVersion ? ` (version ${summary.apiVersion})` : ""}`,
    `Spec: ${summary.openapiVersion} • ${summary.format.toUpperCase()}`,
    `Document URL: ${summary.documentUrl}`,
    `Detected via: ${summary.source}`,
    `Endpoints: ${summary.endpointCount}`,
    `Tags: ${summary.tags.length}`,
  ];

  if (summary.pageUrl && summary.pageUrl !== summary.documentUrl) {
    lines.push(`Source page: ${summary.pageUrl}`);
  }

  if (summary.servers.length > 0) {
    lines.push("Servers:");
    for (const server of summary.servers) {
      lines.push(`- ${server}`);
    }
  }

  if (summary.discoveryTrail.length > 0) {
    lines.push("Discovery trail:");
    for (const trailItem of summary.discoveryTrail) {
      lines.push(`- ${trailItem}`);
    }
  }

  return lines.join("\n");
}

export function formatEndpointList(result: {
  discovery: DiscoverySummary;
  totalEndpoints: number;
  matchedEndpoints: number;
  endpoints: EndpointSummary[];
}): string {
  const lines = [
    `API: ${result.discovery.apiTitle}`,
    `Matched endpoints: ${result.matchedEndpoints}/${result.totalEndpoints}`,
  ];

  if (result.endpoints.length === 0) {
    lines.push("No endpoints matched the provided filters.");
    return lines.join("\n");
  }

  for (const endpoint of result.endpoints) {
    const parts = [`- ${endpoint.method} ${endpoint.path}`];

    if (endpoint.summary) {
      parts.push(`— ${endpoint.summary}`);
    }

    const extras: string[] = [];

    if (endpoint.tags.length > 0) {
      extras.push(`tags: ${endpoint.tags.join(", ")}`);
    }

    if (endpoint.requestContentTypes.length > 0) {
      extras.push(`body: ${endpoint.requestContentTypes.join(", ")}`);
    }

    if (endpoint.responseCodes.length > 0) {
      extras.push(`responses: ${endpoint.responseCodes.join(", ")}`);
    }

    if (endpoint.deprecated) {
      extras.push("deprecated");
    }

    lines.push(parts.join(" "));

    if (extras.length > 0) {
      lines.push(`  ${extras.join(" • ")}`);
    }
  }

  return lines.join("\n");
}

export function formatEndpointDetail(result: {
  discovery: DiscoverySummary;
  endpoint: EndpointDetail;
}): string {
  const { endpoint } = result;
  const lines = [
    `${endpoint.method} ${endpoint.path}`,
    endpoint.summary ?? "No summary provided.",
  ];

  if (endpoint.description) {
    lines.push("", endpoint.description);
  }

  if (endpoint.operationId) {
    lines.push("", `operationId: ${endpoint.operationId}`);
  }

  if (endpoint.tags.length > 0) {
    lines.push(`tags: ${endpoint.tags.join(", ")}`);
  }

  if (endpoint.security.length > 0) {
    lines.push(`security: ${endpoint.security.join(", ")}`);
  }

  if (endpoint.servers.length > 0) {
    lines.push("servers:");
    for (const server of endpoint.servers) {
      lines.push(`- ${server}`);
    }
  }

  if (endpoint.parameters.length > 0) {
    lines.push("parameters:");
    for (const parameter of endpoint.parameters) {
      lines.push(
        `- ${parameter.in}.${parameter.name}${parameter.required ? " (required)" : ""}${parameter.description ? ` — ${parameter.description}` : ""}`,
      );
      if (parameter.schema) {
        lines.push(`  schema: ${describeSchemaInline(parameter.schema)}`);
      }
    }
  }

  if (endpoint.requestBody) {
    lines.push(
      `request body${endpoint.requestBody.required ? " (required)" : ""}: ${endpoint.requestBody.contentTypes.join(", ") || "unspecified"}`,
    );
    for (const entry of endpoint.requestBody.entries) {
      lines.push(
        `- ${entry.contentType}${entry.schema ? ` — ${describeSchemaInline(entry.schema)}` : ""}`,
      );
    }
  }

  if (endpoint.responses.length > 0) {
    lines.push("responses:");
    for (const response of endpoint.responses) {
      lines.push(
        `- ${response.status}${response.description ? ` — ${response.description}` : ""}`,
      );
      if (response.contentTypes.length > 0) {
        lines.push(`  content: ${response.contentTypes.join(", ")}`);
      }
      for (const entry of response.entries) {
        if (entry.schema) {
          lines.push(
            `  - ${entry.contentType}: ${describeSchemaInline(entry.schema)}`,
          );
        }
      }
    }
  }

  return lines.join("\n");
}

export function formatParameterUsageTrace(result: {
  search: {
    parameterName: string;
    entityName?: string;
  };
  totalMatches: number;
  matches: ParameterUsageMatch[];
}): string {
  const lines = [
    `Trace for: ${result.search.parameterName}${result.search.entityName ? ` (entity: ${result.search.entityName})` : ""}`,
    `Matches: ${result.totalMatches}`,
  ];

  if (result.matches.length === 0) {
    lines.push("No matching parameter or field usages were found.");
    return lines.join("\n");
  }

  for (const match of result.matches) {
    lines.push(
      `- ${match.method} ${match.path} • ${match.location} • ${match.fieldPath ?? match.fieldName}`,
    );
    lines.push(`  ${match.reason}`);
  }

  return lines.join("\n");
}

export function formatRelatedEndpoints(result: {
  source: EndpointDetail;
  relatedEndpoints: RelatedEndpointMatch[];
}): string {
  const lines = [
    `Related endpoints for ${result.source.method} ${result.source.path}`,
  ];

  if (result.relatedEndpoints.length === 0) {
    lines.push("No related endpoints were identified.");
    return lines.join("\n");
  }

  for (const endpoint of result.relatedEndpoints) {
    lines.push(
      `- ${endpoint.method} ${endpoint.path} (score: ${endpoint.score})${endpoint.summary ? ` — ${endpoint.summary}` : ""}`,
    );
    lines.push(`  ${endpoint.reasons.join(" • ")}`);
  }

  return lines.join("\n");
}

interface SearchNeedles {
  raw: string;
  normalized: string;
  aliases: Set<string>;
  entityName?: string;
  entityNormalized?: string;
  expectsIdentity: boolean;
}

interface MatchDecision {
  matchedBy: ParameterUsageMatch["matchedBy"];
  reason: string;
}

interface EndpointSignals {
  resourceTokens: string[];
  identifiers: string[];
  entityIdEntities: string[];
}

function buildParameterNeedles(
  parameterName: string,
  entityName?: string,
): SearchNeedles {
  const normalized = normalizeIdentifier(parameterName);
  const inferredEntity = inferEntityName(parameterName);
  const finalEntity = entityName ?? inferredEntity;
  const entityNormalized = finalEntity
    ? normalizeIdentifier(finalEntity)
    : undefined;
  const aliases = new Set<string>([normalized]);

  const leaf = normalizeIdentifier(
    parameterName.split(".").pop() ?? parameterName,
  );
  aliases.add(leaf);

  if (entityNormalized) {
    aliases.add(`${entityNormalized}id`);
    aliases.add(`${entityNormalized}uuid`);
    aliases.add(`${entityNormalized}slug`);
  }

  return {
    raw: parameterName,
    normalized,
    aliases,
    entityName: finalEntity,
    entityNormalized,
    expectsIdentity: isIdentityName(normalized),
  };
}

function matchFieldCandidate(input: {
  fieldName: string;
  fieldPath?: string;
  path: string;
  endpoint: EndpointDetail;
  searchNeedles: SearchNeedles;
}): MatchDecision | undefined {
  const fieldNormalized = normalizeIdentifier(input.fieldName);
  const lastSegment = normalizeIdentifier(
    (input.fieldPath ?? input.fieldName).split(".").pop() ?? input.fieldName,
  );

  if (
    input.searchNeedles.aliases.has(fieldNormalized) ||
    input.searchNeedles.aliases.has(lastSegment)
  ) {
    const matchedBy =
      fieldNormalized === input.searchNeedles.normalized
        ? "exact"
        : "normalized";
    return {
      matchedBy,
      reason: `matched ${input.fieldPath ?? input.fieldName} by ${matchedBy} field comparison`,
    };
  }

  if (
    input.searchNeedles.entityNormalized &&
    input.searchNeedles.expectsIdentity &&
    isIdentityName(fieldNormalized) &&
    tokenizePathResources(input.path).includes(
      input.searchNeedles.entityNormalized,
    )
  ) {
    return {
      matchedBy: "entity-id-heuristic",
      reason: `matched ${input.fieldPath ?? input.fieldName} as the identity field of the ${input.searchNeedles.entityName} resource`,
    };
  }

  return undefined;
}

function collectBodyFieldMatches(input: {
  doc: OpenApiDocument;
  endpoint: EndpointDetail;
  body: RequestBodySummary | undefined;
  location: ParameterUsageMatch["location"];
  searchNeedles: SearchNeedles;
  originalOperation: JsonObject;
  originalPathItem: JsonObject;
  includeResponses: boolean;
}): ParameterUsageMatch[] {
  const matches: ParameterUsageMatch[] = [];
  const requestBody = resolveMaybeRef(
    input.doc,
    input.originalOperation.requestBody,
  );

  if (isObject(requestBody) && isObject(requestBody.content)) {
    for (const [contentType, mediaType] of Object.entries(
      requestBody.content,
    )) {
      if (!isObject(mediaType)) {
        continue;
      }
      matches.push(
        ...collectSchemaFieldMatches({
          doc: input.doc,
          endpoint: input.endpoint,
          schemaValue: mediaType.schema,
          location: input.location,
          searchNeedles: input.searchNeedles,
          reasonPrefix: `request body field in ${contentType}`,
        }),
      );
    }

    return matches;
  }

  const swaggerBodyParameters = extractParametersArray(
    input.originalOperation.parameters,
  )
    .map((parameter) => resolveParameter(input.doc, parameter))
    .filter(
      (parameter): parameter is JsonObject =>
        isObject(parameter) && parameter.in === "body",
    );

  for (const parameter of swaggerBodyParameters) {
    matches.push(
      ...collectSchemaFieldMatches({
        doc: input.doc,
        endpoint: input.endpoint,
        schemaValue: parameter.schema,
        location: input.location,
        searchNeedles: input.searchNeedles,
        reasonPrefix: "request body field",
      }),
    );
  }

  const formDataParameters = extractParametersArray(
    input.originalOperation.parameters,
  )
    .map((parameter) => resolveParameter(input.doc, parameter))
    .filter(
      (parameter): parameter is JsonObject =>
        isObject(parameter) && parameter.in === "formData",
    );

  for (const parameter of formDataParameters) {
    if (typeof parameter.name !== "string") {
      continue;
    }

    const match = matchFieldCandidate({
      fieldName: parameter.name,
      fieldPath: parameter.name,
      path: input.endpoint.path,
      endpoint: input.endpoint,
      searchNeedles: input.searchNeedles,
    });

    if (!match) {
      continue;
    }

    matches.push({
      method: input.endpoint.method,
      path: input.endpoint.path,
      operationId: input.endpoint.operationId,
      summary: input.endpoint.summary,
      tags: input.endpoint.tags,
      location: input.location,
      fieldName: parameter.name,
      fieldPath: parameter.name,
      schemaRef: undefined,
      matchedBy: match.matchedBy,
      reason: `${match.reason} (form-data field)`,
    });
  }

  return matches;
}

function collectResponseFieldMatches(input: {
  doc: OpenApiDocument;
  endpoint: EndpointDetail;
  responses: ResponseSummary[];
  operation: JsonObject;
  pathItem: JsonObject;
  searchNeedles: SearchNeedles;
}): ParameterUsageMatch[] {
  const matches: ParameterUsageMatch[] = [];
  const responses = isObject(input.operation.responses)
    ? input.operation.responses
    : {};

  for (const [status, responseValue] of Object.entries(responses)) {
    const response = resolveMaybeRef(input.doc, responseValue);
    if (!isObject(response) || !isObject(response.content)) {
      continue;
    }

    for (const [contentType, mediaType] of Object.entries(response.content)) {
      if (!isObject(mediaType)) {
        continue;
      }

      matches.push(
        ...collectSchemaFieldMatches({
          doc: input.doc,
          endpoint: input.endpoint,
          schemaValue: mediaType.schema,
          location: "response-body",
          searchNeedles: input.searchNeedles,
          reasonPrefix: `response field in ${status} ${contentType}`,
        }),
      );
    }
  }

  return matches;
}

function collectSchemaFieldMatches(input: {
  doc: OpenApiDocument;
  endpoint: EndpointDetail;
  schemaValue: unknown;
  location: ParameterUsageMatch["location"];
  searchNeedles: SearchNeedles;
  reasonPrefix: string;
  currentPath?: string;
  visitedRefs?: Set<string>;
}): ParameterUsageMatch[] {
  const schemaObject = isObject(input.schemaValue)
    ? input.schemaValue
    : undefined;
  const ref =
    typeof schemaObject?.$ref === "string" ? schemaObject.$ref : undefined;
  const resolved = resolveMaybeRef(input.doc, input.schemaValue);

  if (!isObject(resolved)) {
    return [];
  }

  const visitedRefs = new Set(input.visitedRefs ?? []);
  if (ref) {
    if (visitedRefs.has(ref)) {
      return [];
    }
    visitedRefs.add(ref);
  }

  const matches: ParameterUsageMatch[] = [];
  const properties = isObject(resolved.properties)
    ? resolved.properties
    : undefined;
  if (properties) {
    for (const [propertyName, propertySchema] of Object.entries(properties)) {
      const fieldPath = input.currentPath
        ? `${input.currentPath}.${propertyName}`
        : propertyName;
      const match = matchFieldCandidate({
        fieldName: propertyName,
        fieldPath,
        path: input.endpoint.path,
        endpoint: input.endpoint,
        searchNeedles: input.searchNeedles,
      });

      if (match) {
        matches.push({
          method: input.endpoint.method,
          path: input.endpoint.path,
          operationId: input.endpoint.operationId,
          summary: input.endpoint.summary,
          tags: input.endpoint.tags,
          location: input.location,
          fieldName: propertyName,
          fieldPath,
          schemaRef: ref,
          matchedBy: match.matchedBy,
          reason: `${match.reason} (${input.reasonPrefix})`,
        });
      }

      matches.push(
        ...collectSchemaFieldMatches({
          ...input,
          schemaValue: propertySchema,
          currentPath: fieldPath,
          visitedRefs,
        }),
      );
    }
  }

  if (isObject(resolved.items)) {
    matches.push(
      ...collectSchemaFieldMatches({
        ...input,
        schemaValue: resolved.items,
        currentPath: input.currentPath ? `${input.currentPath}[]` : "[]",
        visitedRefs,
      }),
    );
  }

  const combinatorKeys = ["allOf", "oneOf", "anyOf"] as const;
  for (const key of combinatorKeys) {
    const values = resolved[key];
    if (!Array.isArray(values)) {
      continue;
    }

    for (const schemaEntry of values) {
      matches.push(
        ...collectSchemaFieldMatches({
          ...input,
          schemaValue: schemaEntry,
          visitedRefs,
        }),
      );
    }
  }

  return matches;
}

function dedupeParameterMatches(
  matches: ParameterUsageMatch[],
): ParameterUsageMatch[] {
  const seen = new Set<string>();
  const deduped: ParameterUsageMatch[] = [];

  for (const match of matches) {
    const key = [
      match.method,
      match.path,
      match.location,
      match.fieldPath ?? match.fieldName,
      match.matchedBy,
    ].join("|");
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(match);
  }

  return deduped;
}

function extractEndpointSignals(endpoint: EndpointDetail): EndpointSignals {
  const resourceTokens = tokenizePathResources(endpoint.path);
  const identifiers = new Set<string>();

  for (const parameter of endpoint.parameters) {
    const normalized = normalizeIdentifier(parameter.name);
    if (isIdentityName(normalized)) {
      identifiers.add(normalized);
    }
  }

  const addSchemaIdentifiers = (
    schemas: Array<SchemaDescriptor | undefined>,
  ) => {
    for (const schema of schemas) {
      for (const propertyName of schema?.propertyKeys ?? []) {
        const normalized = normalizeIdentifier(propertyName);
        if (isIdentityName(normalized)) {
          identifiers.add(normalized);
        }
      }
    }
  };

  addSchemaIdentifiers(
    endpoint.requestBody?.entries.map((entry) => entry.schema) ?? [],
  );
  addSchemaIdentifiers(
    endpoint.responses.flatMap((response) =>
      response.entries.map((entry) => entry.schema),
    ),
  );

  const entityIdEntities = [...identifiers]
    .map((identifier) => inferEntityName(identifier))
    .filter((value): value is string => Boolean(value))
    .map((entity) => normalizeIdentifier(entity));

  return {
    resourceTokens,
    identifiers: [...identifiers],
    entityIdEntities: [...new Set(entityIdEntities)],
  };
}

function tokenizePathResources(path: string): string[] {
  return path
    .split("/")
    .filter(Boolean)
    .filter((segment) => !segment.startsWith("{") && !segment.endsWith("}"))
    .map((segment) => segment.toLowerCase())
    .flatMap((segment) => segment.split(/[^a-z0-9]+/).filter(Boolean))
    .map(singularizeToken)
    .filter(Boolean);
}

function singularizeToken(token: string): string {
  if (token.endsWith("ies") && token.length > 3) {
    return token.slice(0, -3) + "y";
  }

  if (token.endsWith("s") && token.length > 1 && !token.endsWith("ss")) {
    return token.slice(0, -1);
  }

  return token;
}

function normalizeIdentifier(value: string): string {
  return value.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
}

function isIdentityName(value: string): boolean {
  return (
    value === "id" ||
    value === "uuid" ||
    value === "slug" ||
    value.endsWith("id") ||
    value.endsWith("uuid") ||
    value.endsWith("slug")
  );
}

function inferEntityName(value: string): string | undefined {
  const normalized = normalizeIdentifier(value);
  if (normalized === "id" || normalized === "uuid" || normalized === "slug") {
    return undefined;
  }

  for (const suffix of ["uuid", "slug", "id"]) {
    if (normalized.endsWith(suffix) && normalized.length > suffix.length) {
      return normalized.slice(0, -suffix.length);
    }
  }

  return undefined;
}

function intersect(left: string[], right: string[]): string[] {
  const rightSet = new Set(right);
  return [...new Set(left.filter((item) => rightSet.has(item)))];
}

function isPathRelated(leftPath: string, rightPath: string): boolean {
  if (leftPath === rightPath) {
    return false;
  }

  const left = leftPath.replace(/\{[^}]+\}/g, "").replace(/\/+/g, "/");
  const right = rightPath.replace(/\{[^}]+\}/g, "").replace(/\/+/g, "/");
  return left.startsWith(right) || right.startsWith(left);
}

async function loadResolvedDocument(
  inputUrl: string,
): Promise<ResolvedDocument> {
  const normalizedInput = normalizeUserUrl(inputUrl).toString();
  const cached = documentCache.get(normalizedInput);

  if (cached) {
    return cached;
  }

  const promise = discoverOpenApiDocument(normalizedInput).catch((error) => {
    documentCache.delete(normalizedInput);
    throw error;
  });

  documentCache.set(normalizedInput, promise);
  return promise;
}

async function discoverOpenApiDocument(
  inputUrl: string,
): Promise<ResolvedDocument> {
  const normalized = normalizeUserUrl(inputUrl);
  const queue = buildInitialCandidates(normalized);
  const visited = new Set<string>();
  const tried: string[] = [];

  while (queue.length > 0 && visited.size < MAX_CANDIDATES) {
    const candidate = queue.shift();

    if (!candidate || visited.has(candidate.url)) {
      continue;
    }

    visited.add(candidate.url);
    tried.push(candidate.url);

    const fetched = await fetchText(candidate.url);

    if (!fetched.ok) {
      continue;
    }

    const directSpec = tryParseOpenApiDocument(fetched.body);
    if (directSpec) {
      return buildResolvedDocument(
        candidate,
        fetched.finalUrl,
        directSpec,
        directSpec.doc,
        inputUrl,
      );
    }

    if (looksLikeHtml(fetched.body, fetched.contentType)) {
      const inlineSpec = extractInlineOpenApiDocument(fetched.body);
      if (inlineSpec) {
        return buildResolvedDocument(
          { ...candidate, source: "inline-html", pageUrl: fetched.finalUrl },
          fetched.finalUrl,
          inlineSpec,
          inlineSpec.doc,
          inputUrl,
        );
      }

      for (const nextCandidate of extractCandidateUrlsFromHtml(
        fetched.body,
        fetched.finalUrl,
        candidate.trail,
      )) {
        if (!visited.has(nextCandidate.url)) {
          queue.push(nextCandidate);
        }
      }
    }
  }

  throw new Error(
    `OpenAPI document could not be detected from ${inputUrl}. Tried: ${tried.slice(0, 10).join(", ")}`,
  );
}

function buildResolvedDocument(
  candidate: CandidateUrl,
  documentUrl: string,
  parsed: ParseSuccess,
  doc: OpenApiDocument,
  inputUrl: string,
): ResolvedDocument {
  const tags = Array.isArray(doc.tags)
    ? doc.tags
        .map((tag: unknown) =>
          isObject(tag) && typeof tag.name === "string" ? tag.name : undefined,
        )
        .filter((tag: string | undefined): tag is string => Boolean(tag))
    : collectEndpointTags(doc);

  const discovery: DiscoverySummary = {
    inputUrl,
    documentUrl,
    pageUrl: candidate.pageUrl,
    source: candidate.source,
    format: parsed.format,
    openapiVersion:
      typeof doc.openapi === "string"
        ? doc.openapi
        : typeof doc.swagger === "string"
          ? doc.swagger
          : "unknown",
    apiTitle: readInfoString(doc, "title") ?? "Untitled API",
    apiVersion: readInfoString(doc, "version"),
    servers: collectServerUrls(doc, undefined, undefined, documentUrl),
    tags,
    endpointCount: extractEndpoints(doc).length,
    discoveryTrail: candidate.trail,
  };

  return {
    discovery,
    document: doc,
  };
}

function buildInitialCandidates(inputUrl: URL): CandidateUrl[] {
  const candidates: CandidateUrl[] = [];
  const seen = new Set<string>();

  const add = (
    url: string,
    source: DiscoverySummary["source"],
    trail: string[],
  ) => {
    if (seen.has(url)) {
      return;
    }

    seen.add(url);
    candidates.push({ url, source, trail });
  };

  add(inputUrl.toString(), "direct", [`direct: ${inputUrl.toString()}`]);

  const root = new URL("/", inputUrl);
  const currentDir = new URL("./", inputUrl);

  for (const path of COMMON_SPEC_PATHS) {
    add(new URL(path, root).toString(), "common-path", [
      `common path from origin: ${path}`,
    ]);
    add(new URL(path, currentDir).toString(), "common-path", [
      `common path from current directory: ${path}`,
    ]);
  }

  return candidates;
}

function extractCandidateUrlsFromHtml(
  html: string,
  pageUrl: string,
  parentTrail: string[],
): CandidateUrl[] {
  const candidates: CandidateUrl[] = [];
  const seen = new Set<string>();
  const add = (rawUrl: string | undefined, reason: string) => {
    const normalized = resolveMaybeRelativeUrl(rawUrl, pageUrl);
    if (!normalized || seen.has(normalized)) {
      return;
    }

    seen.add(normalized);
    candidates.push({
      url: normalized,
      source: "html-link",
      pageUrl,
      trail: [...parentTrail, `${reason}: ${normalized}`],
    });
  };

  const simpleAttributePatterns = [
    /spec-url\s*=\s*["']([^"']+)["']/gi,
    /data-spec-url\s*=\s*["']([^"']+)["']/gi,
    /data-url\s*=\s*["']([^"']+)["']/gi,
    /href\s*=\s*["']([^"']+)["']/gi,
  ];

  for (const pattern of simpleAttributePatterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(html)) !== null) {
      const value = match[1];
      if (isLikelySpecPath(value)) {
        add(value, "html attribute");
      }
    }
  }

  const scriptPatterns = [
    /SwaggerUIBundle\([\s\S]*?\burl\s*:\s*["'`]([^"'`]+)["'`]/gi,
    /Redoc\.init\(\s*["'`]([^"'`]+)["'`]/gi,
    /\b(?:specUrl|spec-url|apiDefinitionUrl|definitionUrl)\b\s*[:=]\s*["'`]([^"'`]+)["'`]/gi,
    /\burl\s*:\s*["'`]([^"'`]+(?:openapi|swagger|api-docs)[^"'`]*)["'`]/gi,
  ];

  for (const pattern of scriptPatterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(html)) !== null) {
      add(match[1], "script config");
    }
  }

  return candidates;
}

function extractInlineOpenApiDocument(html: string): ParseSuccess | undefined {
  const scriptPattern = /<script[^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;

  while ((match = scriptPattern.exec(html)) !== null) {
    const content = match[1]?.trim();
    if (!content) {
      continue;
    }

    const parsed = tryParseOpenApiDocument(content);
    if (parsed) {
      return parsed;
    }
  }

  return undefined;
}

function tryParseOpenApiDocument(text: string): ParseSuccess | undefined {
  const trimmed = text.trim();
  if (!trimmed) {
    return undefined;
  }

  const jsonCandidate = tryParseJson(trimmed);
  if (jsonCandidate && isOpenApiRoot(jsonCandidate)) {
    return { format: "json", doc: jsonCandidate };
  }

  const yamlCandidate = tryParseYaml(trimmed);
  if (yamlCandidate && isOpenApiRoot(yamlCandidate)) {
    return { format: "yaml", doc: yamlCandidate };
  }

  return undefined;
}

function tryParseJson(text: string): OpenApiDocument | undefined {
  try {
    const parsed = JSON.parse(text);
    return isObject(parsed) ? (parsed as OpenApiDocument) : undefined;
  } catch {
    return undefined;
  }
}

function tryParseYaml(text: string): OpenApiDocument | undefined {
  try {
    const parsed = parseYaml(text);
    return isObject(parsed) ? (parsed as OpenApiDocument) : undefined;
  } catch {
    return undefined;
  }
}

function isOpenApiRoot(value: OpenApiDocument): boolean {
  const hasVersion =
    typeof value.openapi === "string" || typeof value.swagger === "string";
  const hasInfo = isObject(value.info);
  const hasPaths =
    isObject(value.paths) ||
    Array.isArray(value.tags) ||
    isObject(value.components as unknown);
  return hasVersion && (hasInfo || hasPaths);
}

async function fetchText(url: string): Promise<FetchedPage> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        Accept: ACCEPT_HEADER,
        "User-Agent": USER_AGENT,
      },
    });

    return {
      ok: response.ok,
      status: response.status,
      contentType: response.headers.get("content-type") ?? "",
      body: await response.text(),
      finalUrl: response.url || url,
    };
  } catch {
    return {
      ok: false,
      status: 0,
      contentType: "",
      body: "",
      finalUrl: url,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function looksLikeHtml(body: string, contentType: string): boolean {
  if (contentType.toLowerCase().includes("text/html")) {
    return true;
  }

  const start = body.trimStart().slice(0, 200).toLowerCase();
  return (
    start.includes("<!doctype html") ||
    start.includes("<html") ||
    start.includes("<body")
  );
}

function extractEndpoints(doc: OpenApiDocument): EndpointSummary[] {
  const paths = isObject(doc.paths) ? doc.paths : {};
  const endpoints: EndpointSummary[] = [];

  for (const [path, pathItemValue] of Object.entries(paths)) {
    if (!isObject(pathItemValue)) {
      continue;
    }

    for (const method of HTTP_METHODS) {
      const operationValue = pathItemValue[method];
      if (!isObject(operationValue)) {
        continue;
      }

      endpoints.push({
        method: method.toUpperCase() as Uppercase<HttpMethod>,
        path,
        operationId:
          typeof operationValue.operationId === "string"
            ? operationValue.operationId
            : undefined,
        summary:
          typeof operationValue.summary === "string"
            ? operationValue.summary
            : undefined,
        description:
          typeof operationValue.description === "string"
            ? operationValue.description
            : undefined,
        tags: extractTagsFromOperation(operationValue),
        deprecated: operationValue.deprecated === true,
        requestContentTypes: extractRequestContentTypes(
          doc,
          pathItemValue,
          operationValue,
        ),
        responseCodes: extractResponseCodes(operationValue),
      });
    }
  }

  return endpoints.sort(
    (left, right) =>
      left.path.localeCompare(right.path) ||
      left.method.localeCompare(right.method),
  );
}

function extractEndpointDetail(
  doc: OpenApiDocument,
  method: Uppercase<HttpMethod>,
  path: string,
  documentUrl: string,
): EndpointDetail | undefined {
  return getOperationContext(doc, method, path, documentUrl)?.endpoint;
}

function getOperationContext(
  doc: OpenApiDocument,
  method: Uppercase<HttpMethod>,
  path: string,
  documentUrl: string,
):
  | {
      endpoint: EndpointDetail;
      securityRequirements: string[][];
      securitySchemes: SecuritySchemeSummary[];
    }
  | undefined {
  const normalizedMethod = method.toLowerCase() as HttpMethod;
  const paths = isObject(doc.paths) ? doc.paths : {};
  const pathItem = paths[path];

  if (!isObject(pathItem)) {
    return undefined;
  }

  const operation = pathItem[normalizedMethod];
  if (!isObject(operation)) {
    return undefined;
  }

  const securityRequirements = collectSecurityRequirements(operation, doc);

  return {
    endpoint: {
      method,
      path,
      operationId:
        typeof operation.operationId === "string"
          ? operation.operationId
          : undefined,
      summary:
        typeof operation.summary === "string" ? operation.summary : undefined,
      description:
        typeof operation.description === "string"
          ? operation.description
          : undefined,
      tags: extractTagsFromOperation(operation),
      deprecated: operation.deprecated === true,
      requestContentTypes: extractRequestContentTypes(doc, pathItem, operation),
      responseCodes: extractResponseCodes(operation),
      servers: collectServerUrls(doc, pathItem, operation, documentUrl),
      security: collectSecurity(operation, doc),
      parameters: summarizeParameters(doc, pathItem, operation),
      requestBody: summarizeRequestBody(doc, operation),
      responses: summarizeResponses(doc, operation),
    },
    securityRequirements,
    securitySchemes: summarizeSecuritySchemes(doc, securityRequirements),
  };
}

function summarizeParameters(
  doc: OpenApiDocument,
  pathItem: JsonObject,
  operation: JsonObject,
): ParameterSummary[] {
  const pathParameters = extractParametersArray(pathItem.parameters);
  const operationParameters = extractParametersArray(operation.parameters);
  const merged = new Map<string, ParameterSummary>();

  for (const parameter of [...pathParameters, ...operationParameters]) {
    const resolved = resolveParameter(doc, parameter);
    if (
      !resolved ||
      typeof resolved.name !== "string" ||
      typeof resolved.in !== "string"
    ) {
      continue;
    }

    const key = `${resolved.in}:${resolved.name}`;
    merged.set(key, {
      name: resolved.name,
      in: resolved.in,
      required: resolved.required === true,
      description:
        typeof resolved.description === "string"
          ? resolved.description
          : undefined,
      deprecated: resolved.deprecated === true,
      schema: summarizeSchema(doc, readSchemaFromParameter(resolved)),
    });
  }

  return [...merged.values()];
}

function summarizeRequestBody(
  doc: OpenApiDocument,
  operation: JsonObject,
): RequestBodySummary | undefined {
  const openApi3Body = resolveMaybeRef(doc, operation.requestBody);
  if (isObject(openApi3Body)) {
    const content = isObject(openApi3Body.content) ? openApi3Body.content : {};
    const entries = Object.entries(content)
      .filter(([, mediaType]) => isObject(mediaType))
      .map(([contentType, mediaType]) => ({
        contentType,
        schema: summarizeSchema(
          doc,
          isObject(mediaType) ? mediaType.schema : undefined,
        ),
      }));

    return {
      required: openApi3Body.required === true,
      contentTypes: entries.map((entry) => entry.contentType),
      entries,
    };
  }

  const swaggerBodyParameter = extractParametersArray(operation.parameters)
    .map((parameter) => resolveParameter(doc, parameter))
    .find((parameter) => isObject(parameter) && parameter.in === "body");

  if (swaggerBodyParameter && isObject(swaggerBodyParameter)) {
    return {
      required: swaggerBodyParameter.required === true,
      contentTypes:
        readStringArray(operation.consumes) ??
        readStringArray(doc.consumes) ??
        [],
      entries: [
        {
          contentType: "application/json",
          schema: summarizeSchema(doc, swaggerBodyParameter.schema),
        },
      ],
    };
  }

  const formDataParameters = extractParametersArray(operation.parameters)
    .map((parameter) => resolveParameter(doc, parameter))
    .filter((parameter) => isObject(parameter) && parameter.in === "formData");

  if (formDataParameters.length > 0) {
    const consumes = readStringArray(operation.consumes) ??
      readStringArray(doc.consumes) ?? ["application/x-www-form-urlencoded"];
    return {
      required: formDataParameters.some(
        (parameter) => isObject(parameter) && parameter.required === true,
      ),
      contentTypes: consumes,
      entries: consumes.map((contentType) => ({
        contentType,
        schema: {
          type: "object",
          propertyKeys: formDataParameters
            .map((parameter) =>
              isObject(parameter) && typeof parameter.name === "string"
                ? parameter.name
                : undefined,
            )
            .filter((name): name is string => Boolean(name)),
        },
      })),
    };
  }

  return undefined;
}

function summarizeResponses(
  doc: OpenApiDocument,
  operation: JsonObject,
): ResponseSummary[] {
  const responses = isObject(operation.responses) ? operation.responses : {};
  const summaries: ResponseSummary[] = [];

  for (const [status, responseValue] of Object.entries(responses)) {
    const response = resolveMaybeRef(doc, responseValue);
    if (!isObject(response)) {
      continue;
    }

    const content = isObject(response.content) ? response.content : {};
    const entries = Object.entries(content)
      .filter(([, mediaType]) => isObject(mediaType))
      .map(([contentType, mediaType]) => ({
        contentType,
        schema: summarizeSchema(
          doc,
          isObject(mediaType) ? mediaType.schema : undefined,
        ),
      }));

    summaries.push({
      status,
      description:
        typeof response.description === "string"
          ? response.description
          : undefined,
      contentTypes:
        entries.length > 0
          ? entries.map((entry) => entry.contentType)
          : (readStringArray(operation.produces) ??
            readStringArray(doc.produces) ??
            []),
      entries,
    });
  }

  return summaries;
}

function summarizeSchema(
  doc: OpenApiDocument,
  schemaValue: unknown,
  depth = 0,
): SchemaDescriptor | undefined {
  const originalSchema = isObject(schemaValue) ? schemaValue : undefined;
  const schema = resolveMaybeRef(doc, schemaValue);
  if (!isObject(schema)) {
    return undefined;
  }

  const descriptor: SchemaDescriptor = {
    ref:
      typeof originalSchema?.$ref === "string"
        ? originalSchema.$ref
        : undefined,
    refName:
      typeof originalSchema?.$ref === "string"
        ? originalSchema.$ref.split("/").pop()
        : undefined,
    type: Array.isArray(schema.type)
      ? schema.type.filter(
          (item: unknown): item is string => typeof item === "string",
        )
      : typeof schema.type === "string"
        ? schema.type
        : undefined,
    format: typeof schema.format === "string" ? schema.format : undefined,
    description:
      typeof schema.description === "string" ? schema.description : undefined,
    nullable:
      schema.nullable === true ||
      (Array.isArray(schema.type) && schema.type.includes("null")) ||
      undefined,
    contentMediaType:
      typeof schema.contentMediaType === "string"
        ? schema.contentMediaType
        : undefined,
    contentEncoding:
      typeof schema.contentEncoding === "string"
        ? schema.contentEncoding
        : undefined,
  };

  if (Array.isArray(schema.enum)) {
    descriptor.enumValues = schema.enum.slice(0, 10);
  }

  if (isObject(schema.properties)) {
    const propertyKeys = Object.keys(schema.properties);
    descriptor.propertyKeys = propertyKeys.slice(0, MAX_SCHEMA_PROPERTIES);
    descriptor.requiredProperties = readStringArray(schema.required) ?? [];
  }

  if (isObject(schema.items)) {
    const itemDescriptor = summarizeSchema(doc, schema.items, depth + 1);
    descriptor.itemType = itemDescriptor?.type;
    descriptor.arrayItemRef = itemDescriptor?.ref;
  }

  const combinators = {
    oneOf: Array.isArray(schema.oneOf) ? schema.oneOf.length : undefined,
    anyOf: Array.isArray(schema.anyOf) ? schema.anyOf.length : undefined,
    allOf: Array.isArray(schema.allOf) ? schema.allOf.length : undefined,
  };

  if (combinators.oneOf || combinators.anyOf || combinators.allOf) {
    descriptor.combinators = combinators;
  }

  if (depth > 0) {
    return cleanSchemaDescriptor(descriptor);
  }

  return cleanSchemaDescriptor(descriptor);
}

function cleanSchemaDescriptor(
  descriptor: SchemaDescriptor,
): SchemaDescriptor | undefined {
  const entries = Object.entries(descriptor).filter(([, value]) => {
    if (value === undefined) {
      return false;
    }

    if (Array.isArray(value) && value.length === 0) {
      return false;
    }

    if (isObject(value) && Object.keys(value).length === 0) {
      return false;
    }

    return true;
  });

  return entries.length > 0
    ? (Object.fromEntries(entries) as SchemaDescriptor)
    : undefined;
}

function describeSchemaInline(schema: SchemaDescriptor): string {
  const parts: string[] = [];

  if (schema.refName || schema.ref) {
    parts.push(schema.refName ? `ref ${schema.refName}` : `ref ${schema.ref}`);
  }

  if (schema.type) {
    parts.push(
      `type ${Array.isArray(schema.type) ? schema.type.join("|") : schema.type}`,
    );
  }

  if (schema.format) {
    parts.push(`format ${schema.format}`);
  }

  if (schema.propertyKeys && schema.propertyKeys.length > 0) {
    parts.push(`props ${schema.propertyKeys.join(", ")}`);
  }

  if (schema.itemType || schema.arrayItemRef) {
    parts.push(`items ${schema.itemType ?? schema.arrayItemRef}`);
  }

  if (schema.enumValues && schema.enumValues.length > 0) {
    parts.push(
      `enum ${schema.enumValues.map((value) => JSON.stringify(value)).join(", ")}`,
    );
  }

  if (schema.contentMediaType) {
    parts.push(`content ${schema.contentMediaType}`);
  }

  return parts.join(" • ") || "schema available";
}

function extractTagsFromOperation(operation: JsonObject): string[] {
  return Array.isArray(operation.tags)
    ? operation.tags.filter(
        (tag: unknown): tag is string => typeof tag === "string",
      )
    : [];
}

function extractRequestContentTypes(
  doc: OpenApiDocument,
  pathItem: JsonObject,
  operation: JsonObject,
): string[] {
  const requestBody = summarizeRequestBody(doc, operation);
  if (requestBody) {
    return requestBody.contentTypes;
  }

  const consumes =
    readStringArray(operation.consumes) ??
    readStringArray(pathItem.consumes) ??
    readStringArray(doc.consumes);
  return consumes ?? [];
}

function extractResponseCodes(operation: JsonObject): string[] {
  const responses = isObject(operation.responses) ? operation.responses : {};
  return Object.keys(responses);
}

function collectSecurity(
  operation: JsonObject,
  doc: OpenApiDocument,
): string[] {
  const security = getEffectiveSecurity(operation, doc);

  const names = new Set<string>();

  for (const entry of security) {
    if (!isObject(entry)) {
      continue;
    }

    for (const key of Object.keys(entry)) {
      names.add(key);
    }
  }

  return [...names];
}

function collectSecurityRequirements(
  operation: JsonObject,
  doc: OpenApiDocument,
): string[][] {
  return getEffectiveSecurity(operation, doc)
    .filter(isObject)
    .map((entry) => Object.keys(entry));
}

function summarizeSecuritySchemes(
  doc: OpenApiDocument,
  requirements: string[][],
): SecuritySchemeSummary[] {
  const components = isObject(doc.components) ? doc.components : undefined;
  const securitySchemes = isObject(components?.securitySchemes)
    ? components.securitySchemes
    : undefined;
  const schemeNames = new Set(requirements.flat());
  const summaries: SecuritySchemeSummary[] = [];

  for (const schemeName of schemeNames) {
    const rawScheme = securitySchemes?.[schemeName];
    const resolvedScheme = resolveMaybeRef(doc, rawScheme);
    if (!isObject(resolvedScheme) || typeof resolvedScheme.type !== "string") {
      continue;
    }

    summaries.push({
      name: schemeName,
      type: resolvedScheme.type,
      description:
        typeof resolvedScheme.description === "string"
          ? resolvedScheme.description
          : undefined,
      scheme:
        typeof resolvedScheme.scheme === "string"
          ? resolvedScheme.scheme
          : undefined,
      bearerFormat:
        typeof resolvedScheme.bearerFormat === "string"
          ? resolvedScheme.bearerFormat
          : undefined,
      in: typeof resolvedScheme.in === "string" ? resolvedScheme.in : undefined,
      parameterName:
        typeof resolvedScheme.name === "string"
          ? resolvedScheme.name
          : undefined,
      openIdConnectUrl:
        typeof resolvedScheme.openIdConnectUrl === "string"
          ? resolvedScheme.openIdConnectUrl
          : undefined,
      oauth2MetadataUrl:
        typeof resolvedScheme.oauth2MetadataUrl === "string"
          ? resolvedScheme.oauth2MetadataUrl
          : undefined,
      flows: summarizeOAuthFlows(resolvedScheme.flows),
    });
  }

  return summaries;
}

function summarizeOAuthFlows(
  flowsValue: unknown,
): SecuritySchemeSummary["flows"] {
  if (!isObject(flowsValue)) {
    return undefined;
  }

  const flowNames = [
    "implicit",
    "password",
    "clientCredentials",
    "authorizationCode",
    "deviceAuthorization",
  ] as const;
  const summarizedFlows: NonNullable<SecuritySchemeSummary["flows"]> = {};

  for (const flowName of flowNames) {
    const flow = flowsValue[flowName];
    if (!isObject(flow)) {
      continue;
    }

    summarizedFlows[flowName] = {
      authorizationUrl:
        typeof flow.authorizationUrl === "string"
          ? flow.authorizationUrl
          : undefined,
      deviceAuthorizationUrl:
        typeof flow.deviceAuthorizationUrl === "string"
          ? flow.deviceAuthorizationUrl
          : undefined,
      tokenUrl: typeof flow.tokenUrl === "string" ? flow.tokenUrl : undefined,
      refreshUrl:
        typeof flow.refreshUrl === "string" ? flow.refreshUrl : undefined,
      scopes: isObject(flow.scopes) ? Object.keys(flow.scopes) : [],
    };
  }

  return Object.keys(summarizedFlows).length > 0 ? summarizedFlows : undefined;
}

function getEffectiveSecurity(
  operation: JsonObject,
  doc: OpenApiDocument,
): unknown[] {
  if (Array.isArray(operation.security)) {
    return operation.security;
  }

  if (Array.isArray(doc.security)) {
    return doc.security;
  }

  return [];
}

function collectServerUrls(
  doc: OpenApiDocument,
  pathItem: JsonObject | undefined,
  operation: JsonObject | undefined,
  documentUrl: string,
): string[] {
  const serverArray = (Array.isArray(operation?.servers)
    ? operation?.servers
    : undefined) ??
    (Array.isArray(pathItem?.servers) ? pathItem?.servers : undefined) ??
    (Array.isArray(doc.servers) ? doc.servers : undefined) ?? [{ url: "/" }];

  return serverArray
    .map((server: unknown) =>
      isObject(server) && typeof server.url === "string"
        ? server.url
        : undefined,
    )
    .filter((url: string | undefined): url is string => Boolean(url))
    .map((url: string) => {
      try {
        return new URL(url, documentUrl).toString();
      } catch {
        return url;
      }
    });
}

function collectEndpointTags(doc: OpenApiDocument): string[] {
  const tags = new Set<string>();
  const paths = isObject(doc.paths) ? doc.paths : {};

  for (const pathItemValue of Object.values(paths)) {
    if (!isObject(pathItemValue)) {
      continue;
    }

    for (const method of HTTP_METHODS) {
      const operation = pathItemValue[method];
      if (!isObject(operation)) {
        continue;
      }

      for (const tag of extractTagsFromOperation(operation)) {
        tags.add(tag);
      }
    }
  }

  return [...tags];
}

function normalizeUserUrl(rawUrl: string): URL {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    throw new Error("A URL is required.");
  }

  const withProtocol = /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  const url = new URL(withProtocol);

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Only HTTP and HTTPS URLs are supported.");
  }

  url.hash = "";
  return url;
}

function normalizeMethod(
  value: string | undefined,
): Uppercase<HttpMethod> | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (HTTP_METHODS.includes(normalized as HttpMethod)) {
    return normalized.toUpperCase() as Uppercase<HttpMethod>;
  }

  return undefined;
}

function resolveMaybeRef(doc: OpenApiDocument, value: unknown): unknown {
  if (!isObject(value) || typeof value.$ref !== "string") {
    return value;
  }

  if (!value.$ref.startsWith("#/")) {
    return value;
  }

  const segments = value.$ref
    .slice(2)
    .split("/")
    .map((segment: string) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));

  let current: unknown = doc;
  for (const segment of segments) {
    if (!isObject(current) || !(segment in current)) {
      return value;
    }
    current = current[segment];
  }

  return current;
}

function resolveParameter(
  doc: OpenApiDocument,
  value: unknown,
): JsonObject | undefined {
  const resolved = resolveMaybeRef(doc, value);
  return isObject(resolved) ? resolved : undefined;
}

function readSchemaFromParameter(parameter: JsonObject): unknown {
  if (isObject(parameter.schema)) {
    return parameter.schema;
  }

  if (isObject(parameter.content)) {
    const firstEntry = Object.values(parameter.content).find(isObject);
    return isObject(firstEntry) ? firstEntry.schema : undefined;
  }

  return undefined;
}

function extractParametersArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readInfoString(doc: OpenApiDocument, key: string): string | undefined {
  return isObject(doc.info) && typeof doc.info[key] === "string"
    ? (doc.info[key] as string)
    : undefined;
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const strings = value.filter(
    (item): item is string => typeof item === "string",
  );
  return strings.length > 0 ? strings : [];
}

function resolveMaybeRelativeUrl(
  rawUrl: string | undefined,
  pageUrl: string,
): string | undefined {
  if (!rawUrl) {
    return undefined;
  }

  const candidate = rawUrl.trim();
  if (
    !candidate ||
    candidate.startsWith("#") ||
    candidate.startsWith("javascript:")
  ) {
    return undefined;
  }

  try {
    const resolved = new URL(candidate, pageUrl);
    return ["http:", "https:"].includes(resolved.protocol)
      ? resolved.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

function isLikelySpecPath(value: string | undefined): boolean {
  if (!value) {
    return false;
  }

  const normalized = value.toLowerCase();
  return (
    normalized.includes("openapi") ||
    normalized.includes("swagger") ||
    normalized.includes("api-docs") ||
    normalized.endsWith(".json") ||
    normalized.endsWith(".yaml") ||
    normalized.endsWith(".yml")
  );
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
