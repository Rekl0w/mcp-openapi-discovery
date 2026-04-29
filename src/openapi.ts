import SwaggerParser from "@apidevtools/swagger-parser";
import { createHash } from "node:crypto";
import {
  mkdir,
  readFile as readFileFromDisk,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
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
  "swagger/v1/swagger.json",
  "swagger/v2/swagger.json",
  "swagger/v3/swagger.json",
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
  "scalar",
  "request-docs",
  "request-docs/api?openapi=true",
  "request-docs/api?openapi=1",
  "api?openapi=true",
  "api?openapi=1",
] as const;

const HIGH_SIGNAL_SPEC_PATHS = [
  "api?openapi=true",
  "api?openapi=1",
  "api/v3/openapi.json",
  "api/v2/openapi.json",
  "api/v1/openapi.json",
  "swagger/v1/swagger.json",
  "request-docs/api?openapi=true",
  "v3/openapi.json",
  "v2/openapi.json",
  "v1/openapi.json",
  "openapi.json",
  "swagger.json",
] as const;

const GENERIC_NON_RESOURCE_SEGMENTS = new Set([
  "api",
  "store",
  "create",
  "update",
  "edit",
  "delete",
  "destroy",
  "remove",
  "getall",
  "getbyid",
  "list",
  "show",
]);

const ACCEPT_HEADER = [
  "application/openapi+json",
  "application/json",
  "application/yaml",
  "text/yaml",
  "text/plain",
  "text/html;q=0.9",
].join(", ");

const USER_AGENT = "mcp-openapi-discovery/0.4.0";
const FETCH_TIMEOUT_MS = 10_000;
const MAX_CANDIDATES = 30;
const MAX_SCHEMA_PROPERTIES = 12;
const DEFAULT_SEARCH_LIMIT = 10;
const MAX_SEARCH_LIMIT = 50;
const CACHE_SCHEMA_VERSION = 2;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_CACHE_REVALIDATE_MS = 0;
const CACHE_DIR_NAME = ".mcp-openapi-discovery-cache";
const DEFAULT_WORKFLOW_LIMIT = 3;
const MAX_WORKFLOW_LIMIT = 5;
const DEFAULT_WORKFLOW_DEPTH = 5;
const MAX_WORKFLOW_DEPTH = 8;
const SEARCH_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "api",
  "endpoint",
  "for",
  "in",
  "of",
  "on",
  "or",
  "the",
  "to",
  "with",
]);
const SEARCH_SYNONYM_GROUPS = [
  ["create", "add", "new", "insert", "register"],
  ["update", "edit", "modify", "patch"],
  ["delete", "remove", "destroy"],
  ["list", "search", "find", "browse", "all"],
  ["get", "fetch", "show", "detail"],
  ["auth", "authenticate", "login", "signin", "token", "oauth"],
  ["upload", "file", "attachment", "media"],
] as const;

type OperationKind =
  | "auth"
  | "create"
  | "list"
  | "get"
  | "update"
  | "delete"
  | "action";

export interface DiscoverySummary {
  specId: string;
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
  style?: string;
  explode?: boolean;
  allowReserved?: boolean;
  collectionFormat?: string;
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

export interface EndpointSearchMatch extends EndpointSummary {
  score: number;
  matchedTerms: string[];
}

export interface CallSequenceStep {
  step: number;
  method: Uppercase<HttpMethod>;
  path: string;
  operationId?: string;
  summary?: string;
  operationKind: OperationKind;
  reasons: string[];
  produces: string[];
  consumes: string[];
}

export interface WorkflowSuggestion {
  target: EndpointSummary;
  confidence: number;
  coveredDependencies: string[];
  missingDependencies: string[];
  steps: CallSequenceStep[];
}

export interface CallSequenceResult {
  discovery: DiscoverySummary;
  goal?: string;
  targetCandidates?: EndpointSearchMatch[];
  workflows: WorkflowSuggestion[];
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
  specId: string;
  discovery: DiscoverySummary;
  document: OpenApiDocument;
  endpoints: EndpointSummary[];
  searchDocuments: EndpointSearchDocument[];
  workflowDocuments: WorkflowDocument[];
}

interface EndpointSearchDocument {
  endpoint: EndpointSummary;
  searchText: string;
  primaryTokens: string[];
  pathTokens: string[];
  operationTokens: string[];
  tagTokens: string[];
  parameterTokens: string[];
  requestTokens: string[];
  responseTokens: string[];
  requestFieldDepths: Record<string, number>;
  responseFieldDepths: Record<string, number>;
  operationKind: OperationKind;
}

interface StructuredFieldDescriptor {
  fieldName: string;
  fieldPath: string;
  normalizedName: string;
  required: boolean;
  depth: number;
}

interface WorkflowSignal {
  name: string;
  normalizedName: string;
  aliases: string[];
  source:
    | "path-parameter"
    | "query-parameter"
    | "request-body"
    | "response-body"
    | "auth";
  required: boolean;
  depth: number;
}

interface WorkflowDocument {
  key: string;
  endpoint: EndpointDetail;
  operationKind: OperationKind;
  isAuthEndpoint: boolean;
  resourceTokens: string[];
  requiredInputs: WorkflowSignal[];
  optionalInputs: WorkflowSignal[];
  producedOutputs: WorkflowSignal[];
}

interface CachedDocumentRecord {
  schemaVersion: number;
  cachedAt: string;
  normalizedInput: string;
  resolved: ResolvedDocument;
}

interface DocumentCacheEntry {
  promise: Promise<ResolvedDocument>;
  lastValidatedAt: number;
  pending: boolean;
}

interface SpecCacheEntry {
  normalizedInput: string;
  resolved: ResolvedDocument;
  lastValidatedAt: number;
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

const documentCache = new Map<string, DocumentCacheEntry>();
const specCache = new Map<string, SpecCacheEntry>();

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
  const endpoints = resolved.endpoints;
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

export async function searchOpenApiEndpoints(
  specId: string,
  query: string,
  filters: {
    tag?: string;
    method?: string;
    includeDeprecated?: boolean;
    limit?: number;
  } = {},
): Promise<{
  discovery: DiscoverySummary;
  search: {
    specId: string;
    query: string;
  };
  totalMatches: number;
  endpoints: EndpointSearchMatch[];
}> {
  const resolved = await loadResolvedDocumentBySpecId(specId);

  if (!resolved) {
    throw new Error(
      `Unknown specId: ${specId}. Run detect_openapi first so the spec is loaded into server memory.`,
    );
  }

  const searchTerms = buildSearchTerms(query);
  if (searchTerms.length === 0) {
    throw new Error("Search query must include at least one searchable term.");
  }

  const normalizedMethod = normalizeMethod(filters.method);
  const tagFilter = filters.tag?.trim().toLowerCase();
  const includeDeprecated = filters.includeDeprecated ?? true;
  const limit = Math.max(
    1,
    Math.min(filters.limit ?? DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT),
  );
  const normalizedPhrase = normalizeSearchText(query).trim();
  const desiredOperationKinds = inferDesiredOperationKinds(searchTerms);

  const matches = resolved.searchDocuments
    .filter(({ endpoint }) => {
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

      return true;
    })
    .map((searchDocument) =>
      scoreSearchDocument(
        searchDocument,
        searchTerms,
        normalizedPhrase,
        desiredOperationKinds,
      ),
    )
    .filter(
      (
        match,
      ): match is {
        endpoint: EndpointSummary;
        score: number;
        matchedTerms: string[];
      } => Boolean(match),
    )
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.endpoint.path.localeCompare(right.endpoint.path) ||
        left.endpoint.method.localeCompare(right.endpoint.method),
    );

  return {
    discovery: resolved.discovery,
    search: {
      specId,
      query,
    },
    totalMatches: matches.length,
    endpoints: matches.slice(0, limit).map((match) => ({
      ...match.endpoint,
      score: match.score,
      matchedTerms: match.matchedTerms,
    })),
  };
}

export async function suggestCallSequence(input: {
  specId: string;
  targetMethod?: string;
  targetPath?: string;
  goal?: string;
  limit?: number;
  maxDepth?: number;
}): Promise<CallSequenceResult> {
  const resolved = await loadResolvedDocumentBySpecId(input.specId);

  if (!resolved) {
    throw new Error(
      `Unknown specId: ${input.specId}. Run detect_openapi first so the spec is loaded into server memory.`,
    );
  }

  const maxDepth = Math.max(
    1,
    Math.min(input.maxDepth ?? DEFAULT_WORKFLOW_DEPTH, MAX_WORKFLOW_DEPTH),
  );
  const limit = Math.max(
    1,
    Math.min(input.limit ?? DEFAULT_WORKFLOW_LIMIT, MAX_WORKFLOW_LIMIT),
  );

  let targetCandidates: EndpointSearchMatch[] | undefined;
  let targets: EndpointSummary[] = [];
  let targetRank = new Map<string, number>();

  if (input.goal?.trim()) {
    const searchResult = await searchOpenApiEndpoints(
      input.specId,
      input.goal,
      {
        limit,
      },
    );
    targetCandidates = searchResult.endpoints;
    targets = targetCandidates;
    targetRank = new Map(
      targetCandidates.map((candidate, index) => [
        `${candidate.method} ${candidate.path}`,
        index,
      ]),
    );
  } else {
    const normalizedMethod = normalizeMethod(input.targetMethod);
    if (!normalizedMethod || !input.targetPath) {
      throw new Error(
        "Provide either goal, or both targetMethod and targetPath.",
      );
    }

    const normalizedTargetPath = normalizeOperationPathInput(input.targetPath);

    const target = resolved.endpoints.find(
      (endpoint) =>
        endpoint.method === normalizedMethod &&
        (endpoint.path === input.targetPath ||
          normalizeOperationPathInput(endpoint.path) === normalizedTargetPath),
    );

    if (!target) {
      throw new Error(
        `Target endpoint not found for ${normalizedMethod} ${input.targetPath}`,
      );
    }

    targets = [target];
  }

  const workflows = targets
    .map((target) => buildWorkflowSuggestion(resolved, target, maxDepth))
    .filter((workflow): workflow is WorkflowSuggestion => Boolean(workflow))
    .sort(
      (left, right) =>
        (targetRank.get(`${left.target.method} ${left.target.path}`) ??
          Number.MAX_SAFE_INTEGER) -
          (targetRank.get(`${right.target.method} ${right.target.path}`) ??
            Number.MAX_SAFE_INTEGER) ||
        right.confidence - left.confidence ||
        left.missingDependencies.length - right.missingDependencies.length ||
        left.target.path.localeCompare(right.target.path) ||
        left.target.method.localeCompare(right.target.method),
    )
    .slice(0, limit);

  return {
    discovery: resolved.discovery,
    goal: input.goal,
    targetCandidates,
    workflows,
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
  const normalizedFilterPath = options.path
    ? normalizeOperationPathInput(options.path)
    : undefined;
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

    if (
      normalizedFilterPath &&
      path !== options.path &&
      normalizeOperationPathInput(path) !== normalizedFilterPath
    ) {
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
    `Spec ID: ${summary.specId}`,
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

export function formatEndpointSearchResults(result: {
  search: {
    specId: string;
    query: string;
  };
  totalMatches: number;
  endpoints: EndpointSearchMatch[];
}): string {
  const lines = [
    `Search query: ${result.search.query}`,
    `Spec ID: ${result.search.specId}`,
    `Matches: ${result.totalMatches}`,
  ];

  if (result.endpoints.length === 0) {
    lines.push("No endpoints matched the search query.");
    return lines.join("\n");
  }

  for (const endpoint of result.endpoints) {
    lines.push(
      `- ${endpoint.method} ${endpoint.path} (score: ${endpoint.score.toFixed(2)})${endpoint.summary ? ` — ${endpoint.summary}` : ""}`,
    );

    const extras: string[] = [];
    if (endpoint.tags.length > 0) {
      extras.push(`tags: ${endpoint.tags.join(", ")}`);
    }
    if (endpoint.matchedTerms.length > 0) {
      extras.push(`matched: ${endpoint.matchedTerms.join(", ")}`);
    }
    if (extras.length > 0) {
      lines.push(`  ${extras.join(" • ")}`);
    }
  }

  return lines.join("\n");
}

export function formatCallSequenceResult(result: CallSequenceResult): string {
  const lines = [
    `API: ${result.discovery.apiTitle}`,
    result.goal ? `Goal: ${result.goal}` : "Workflow suggestion:",
  ];

  if (result.targetCandidates && result.targetCandidates.length > 0) {
    lines.push("Target candidates:");
    for (const candidate of result.targetCandidates) {
      lines.push(
        `- ${candidate.method} ${candidate.path} (score: ${candidate.score.toFixed(2)})${candidate.summary ? ` — ${candidate.summary}` : ""}`,
      );
    }
  }

  if (result.workflows.length === 0) {
    lines.push(
      "No workflow suggestions could be built for the requested target.",
    );
    return lines.join("\n");
  }

  for (const workflow of result.workflows) {
    lines.push("");
    lines.push(
      `Target: ${workflow.target.method} ${workflow.target.path} (confidence: ${workflow.confidence.toFixed(2)})`,
    );

    if (workflow.coveredDependencies.length > 0) {
      lines.push(
        `Covered dependencies: ${workflow.coveredDependencies.join(", ")}`,
      );
    }

    if (workflow.missingDependencies.length > 0) {
      lines.push(
        `Missing dependencies: ${workflow.missingDependencies.join(", ")}`,
      );
    }

    for (const step of workflow.steps) {
      lines.push(
        `${step.step}. ${step.method} ${step.path}${step.summary ? ` — ${step.summary}` : ""}`,
      );

      if (step.reasons.length > 0) {
        lines.push(`   why: ${step.reasons.join(" • ")}`);
      }

      if (step.consumes.length > 0) {
        lines.push(`   consumes: ${step.consumes.join(", ")}`);
      }

      if (step.produces.length > 0) {
        lines.push(`   produces: ${step.produces.join(", ")}`);
      }
    }
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

async function loadResolvedDocumentBySpecId(
  specId: string,
): Promise<ResolvedDocument | undefined> {
  const cached = specCache.get(specId);
  if (cached) {
    return loadResolvedDocument(cached.normalizedInput);
  }

  const persisted = await readCachedDocumentBySpecId(specId);
  if (!persisted) {
    return undefined;
  }

  hydrateResolvedDocument(
    persisted.normalizedInput,
    persisted.resolved,
    parseCacheTimestamp(persisted.cachedAt),
  );
  return loadResolvedDocument(persisted.normalizedInput);
}

async function loadResolvedDocument(
  inputUrl: string,
): Promise<ResolvedDocument> {
  const normalizedInput = normalizeUserUrl(inputUrl).toString();
  const cached = documentCache.get(normalizedInput);

  if (cached) {
    if (cached.pending || !shouldRevalidateCache(cached.lastValidatedAt)) {
      return cached.promise;
    }

    const refreshPromise = cached.promise
      .then((resolved) => refreshResolvedDocument(normalizedInput, resolved))
      .catch((error) => {
        documentCache.delete(normalizedInput);
        throw error;
      });

    documentCache.set(normalizedInput, {
      promise: refreshPromise,
      lastValidatedAt: cached.lastValidatedAt,
      pending: true,
    });

    return refreshPromise;
  }

  const persisted = await readCachedDocumentByInput(normalizedInput);
  if (persisted) {
    hydrateResolvedDocument(
      normalizedInput,
      persisted.resolved,
      parseCacheTimestamp(persisted.cachedAt),
    );
    return loadResolvedDocument(normalizedInput);
  }

  const promise = discoverOpenApiDocument(normalizedInput).catch((error) => {
    documentCache.delete(normalizedInput);
    throw error;
  });

  documentCache.set(normalizedInput, {
    promise,
    lastValidatedAt: Date.now(),
    pending: true,
  });
  return promise;
}

async function refreshResolvedDocument(
  normalizedInput: string,
  cached: ResolvedDocument,
): Promise<ResolvedDocument> {
  try {
    const refreshed = await refreshResolvedDocumentFromCanonicalSource(
      normalizedInput,
      cached,
    );
    hydrateResolvedDocument(normalizedInput, refreshed, Date.now());
    return refreshed;
  } catch {
    try {
      const rediscovered = await discoverOpenApiDocument(normalizedInput);
      hydrateResolvedDocument(normalizedInput, rediscovered, Date.now());
      return rediscovered;
    } catch {
      hydrateResolvedDocument(normalizedInput, cached, Date.now());
      return cached;
    }
  }
}

async function refreshResolvedDocumentFromCanonicalSource(
  normalizedInput: string,
  cached: ResolvedDocument,
): Promise<ResolvedDocument> {
  const fetched = await fetchText(cached.discovery.documentUrl);
  if (!fetched.ok) {
    throw new Error(
      `Canonical OpenAPI document returned ${fetched.status} for ${cached.discovery.documentUrl}`,
    );
  }

  const cachedHash = hashOpenApiDocument(cached.document);
  const candidate: CandidateUrl = {
    url: cached.discovery.documentUrl,
    source: cached.discovery.source,
    trail: cached.discovery.discoveryTrail,
    pageUrl: cached.discovery.pageUrl,
  };

  const directSpec = tryParseOpenApiDocument(fetched.body);
  if (directSpec) {
    const bundledDoc = await bundleOpenApiDocument(
      fetched.finalUrl,
      directSpec.doc,
    );

    if (
      hashOpenApiDocument(bundledDoc) === cachedHash &&
      fetched.finalUrl === cached.discovery.documentUrl
    ) {
      await persistResolvedDocument(normalizedInput, cached);
      return cached;
    }

    const resolved = buildResolvedDocument(
      candidate,
      fetched.finalUrl,
      directSpec,
      bundledDoc,
      normalizedInput,
    );
    await persistResolvedDocument(normalizedInput, resolved);
    return resolved;
  }

  if (looksLikeHtml(fetched.body, fetched.contentType)) {
    const inlineSpec = extractInlineOpenApiDocument(fetched.body);
    if (inlineSpec) {
      if (
        hashOpenApiDocument(inlineSpec.doc) === cachedHash &&
        fetched.finalUrl === cached.discovery.documentUrl &&
        cached.discovery.source === "inline-html"
      ) {
        await persistResolvedDocument(normalizedInput, cached);
        return cached;
      }

      const resolved = buildResolvedDocument(
        { ...candidate, source: "inline-html", pageUrl: fetched.finalUrl },
        fetched.finalUrl,
        inlineSpec,
        inlineSpec.doc,
        normalizedInput,
      );
      await persistResolvedDocument(normalizedInput, resolved);
      return resolved;
    }
  }

  throw new Error(
    `Canonical OpenAPI document at ${cached.discovery.documentUrl} no longer contains a parseable spec.`,
  );
}

function hashOpenApiDocument(doc: OpenApiDocument): string {
  return createHash("sha256").update(JSON.stringify(doc)).digest("hex");
}

function shouldRevalidateCache(lastValidatedAt: number): boolean {
  const revalidateMs = getCacheRevalidateMs();
  if (revalidateMs === 0) {
    return true;
  }

  return Date.now() - lastValidatedAt >= revalidateMs;
}

function getCacheRevalidateMs(): number {
  const raw = process.env.MCP_OPENAPI_DISCOVERY_REVALIDATE_MS?.trim();
  if (!raw) {
    return DEFAULT_CACHE_REVALIDATE_MS;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_CACHE_REVALIDATE_MS;
  }

  return Math.min(parsed, CACHE_TTL_MS);
}

function parseCacheTimestamp(value: string | undefined): number {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
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
      const bundledDoc = await bundleOpenApiDocument(
        fetched.finalUrl,
        directSpec.doc,
      );
      const resolved = buildResolvedDocument(
        candidate,
        fetched.finalUrl,
        directSpec,
        bundledDoc,
        inputUrl,
      );
      await persistResolvedDocument(inputUrl, resolved);
      return resolved;
    }

    if (looksLikeHtml(fetched.body, fetched.contentType)) {
      const inlineSpec = extractInlineOpenApiDocument(fetched.body);
      if (inlineSpec) {
        const resolved = buildResolvedDocument(
          { ...candidate, source: "inline-html", pageUrl: fetched.finalUrl },
          fetched.finalUrl,
          inlineSpec,
          inlineSpec.doc,
          inputUrl,
        );
        await persistResolvedDocument(inputUrl, resolved);
        return resolved;
      }

      const discoveredCandidates = extractCandidateUrlsFromHtml(
        fetched.body,
        fetched.finalUrl,
        candidate.trail,
      );

      for (const nextCandidate of discoveredCandidates.reverse()) {
        if (!visited.has(nextCandidate.url)) {
          queue.unshift(nextCandidate);
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
  const specId = buildSpecId(documentUrl);
  const endpoints = extractEndpoints(doc);
  const workflowDocuments = buildWorkflowDocuments(doc, documentUrl);
  const tags = Array.isArray(doc.tags)
    ? doc.tags
        .map((tag: unknown) =>
          isObject(tag) && typeof tag.name === "string" ? tag.name : undefined,
        )
        .filter((tag: string | undefined): tag is string => Boolean(tag))
    : collectEndpointTags(doc);

  const discovery: DiscoverySummary = {
    specId,
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
    endpointCount: endpoints.length,
    discoveryTrail: candidate.trail,
  };

  const resolved: ResolvedDocument = {
    specId,
    discovery,
    document: doc,
    endpoints,
    searchDocuments: buildEndpointSearchDocuments(
      doc,
      documentUrl,
      workflowDocuments,
    ),
    workflowDocuments,
  };

  hydrateResolvedDocument(inputUrl, resolved);

  return resolved;
}

function hydrateResolvedDocument(
  normalizedInput: string,
  resolved: ResolvedDocument,
  lastValidatedAt = Date.now(),
): void {
  specCache.set(resolved.specId, {
    normalizedInput,
    resolved,
    lastValidatedAt,
  });
  documentCache.set(normalizedInput, {
    promise: Promise.resolve(resolved),
    lastValidatedAt,
    pending: false,
  });
}

async function readCachedDocumentByInput(
  normalizedInput: string,
): Promise<CachedDocumentRecord | undefined> {
  return readCachedDocument(getInputCacheFilePath(normalizedInput));
}

async function readCachedDocumentBySpecId(
  specId: string,
): Promise<CachedDocumentRecord | undefined> {
  return readCachedDocument(getSpecCacheFilePath(specId));
}

async function readCachedDocument(
  filePath: string,
): Promise<CachedDocumentRecord | undefined> {
  try {
    const raw = await readFileFromDisk(filePath, "utf8");
    const parsed = JSON.parse(raw) as CachedDocumentRecord;
    if (
      parsed.schemaVersion !== CACHE_SCHEMA_VERSION ||
      !parsed.cachedAt ||
      Date.now() - Date.parse(parsed.cachedAt) > CACHE_TTL_MS
    ) {
      return undefined;
    }

    return parsed;
  } catch {
    return undefined;
  }
}

async function persistResolvedDocument(
  normalizedInput: string,
  resolved: ResolvedDocument,
): Promise<void> {
  const cacheRecord: CachedDocumentRecord = {
    schemaVersion: CACHE_SCHEMA_VERSION,
    cachedAt: new Date().toISOString(),
    normalizedInput,
    resolved,
  };

  const directory = getCacheDirectory();
  await mkdir(directory, { recursive: true });

  const serialized = JSON.stringify(cacheRecord);
  await Promise.all([
    writeFile(getInputCacheFilePath(normalizedInput), serialized, "utf8"),
    writeFile(getSpecCacheFilePath(resolved.specId), serialized, "utf8"),
  ]);
}

function getCacheDirectory(): string {
  return (
    process.env.MCP_OPENAPI_DISCOVERY_CACHE_DIR?.trim() ||
    join(homedir(), CACHE_DIR_NAME)
  );
}

function getInputCacheFilePath(normalizedInput: string): string {
  return join(
    getCacheDirectory(),
    `input-${createHash("sha256").update(normalizedInput).digest("hex")}.json`,
  );
}

function getSpecCacheFilePath(specId: string): string {
  return join(getCacheDirectory(), `${specId}.json`);
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

  const root = new URL("/", inputUrl);
  const currentDir = new URL("./", inputUrl);
  const pageDir = getPageDirectoryUrl(inputUrl);

  add(inputUrl.toString(), "direct", [`direct: ${inputUrl.toString()}`]);
  add(root.toString(), "common-path", [
    `origin root fallback: ${root.toString()}`,
  ]);

  for (const path of HIGH_SIGNAL_SPEC_PATHS) {
    add(new URL(path, pageDir).toString(), "common-path", [
      `high-signal page-directory path: ${path}`,
    ]);
    add(new URL(path, root).toString(), "common-path", [
      `high-signal origin path: ${path}`,
    ]);
    add(new URL(path, currentDir).toString(), "common-path", [
      `high-signal current-directory path: ${path}`,
    ]);
  }

  for (const path of COMMON_SPEC_PATHS) {
    add(new URL(path, root).toString(), "common-path", [
      `common path from origin: ${path}`,
    ]);
    add(new URL(path, currentDir).toString(), "common-path", [
      `common path from current directory: ${path}`,
    ]);
    add(new URL(path, pageDir).toString(), "common-path", [
      `common path from page directory: ${path}`,
    ]);
  }

  return candidates;
}

function getPageDirectoryUrl(inputUrl: URL): URL {
  const pageDir = new URL(inputUrl.toString());
  pageDir.search = "";
  if (!pageDir.pathname.endsWith("/")) {
    pageDir.pathname = `${pageDir.pathname}/`;
  }
  return pageDir;
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
    /\\?["'](?:url|specUrl|configUrl)\\?["']\s*:\s*\\?["'`]([^"'`]+)["'`]/gi,
    /\bsources\b[\s\S]*?\\?["']url\\?["']\s*:\s*\\?["'`]([^"'`]+)["'`]/gi,
    /Download OpenAPI Document[^\n\r]*\(([^)]+(?:openapi|swagger|api-docs)[^)]+)\)/gi,
  ];

  for (const pattern of scriptPatterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(html)) !== null) {
      add(match[1], "script config");
    }
  }

  const rawSpecPathPatterns = [
    /(?:\/|\.\/|\.\.\/)?(?:swagger|openapi|api-docs)[^"'`\s)]*\.(?:json|ya?ml)(?:\?[^"'`\s)]*)?/gi,
    /(?:\/|\.\/|\.\.\/)?[^"'`\s)]*\?openapi=(?:true|1)[^"'`\s)]*/gi,
  ];

  for (const pattern of rawSpecPathPatterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(html)) !== null) {
      add(match[0], "raw spec path");
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

async function bundleOpenApiDocument(
  documentUrl: string,
  fallbackDoc: OpenApiDocument,
): Promise<OpenApiDocument> {
  try {
    const bundled = await SwaggerParser.bundle(documentUrl, {
      resolve: {
        http: createHttpResolver(),
        https: createHttpResolver(),
      },
    });

    return isObject(bundled) ? (bundled as OpenApiDocument) : fallbackDoc;
  } catch {
    return fallbackDoc;
  }
}

function createHttpResolver(): {
  order: number;
  canRead: RegExp;
  read(file: { url: string }): Promise<string>;
} {
  return {
    order: 1,
    canRead: /^https?:/i,
    async read(file: { url: string }): Promise<string> {
      const fetched = await fetchText(file.url);
      if (!fetched.ok) {
        throw new Error(`Failed to fetch OpenAPI reference: ${file.url}`);
      }
      return fetched.body;
    },
  };
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

function buildEndpointSearchDocuments(
  doc: OpenApiDocument,
  documentUrl: string,
  workflowDocuments: WorkflowDocument[],
): EndpointSearchDocument[] {
  const paths = isObject(doc.paths) ? doc.paths : {};
  const documents: EndpointSearchDocument[] = [];
  const workflowMap = new Map(
    workflowDocuments.map((workflow) => [workflow.key, workflow]),
  );

  for (const [path, pathItem] of Object.entries(paths)) {
    if (!isObject(pathItem)) {
      continue;
    }

    for (const method of HTTP_METHODS) {
      const operation = pathItem[method];
      if (!isObject(operation)) {
        continue;
      }

      const upperMethod = method.toUpperCase() as Uppercase<HttpMethod>;
      const context = getOperationContext(doc, upperMethod, path, documentUrl);
      if (!context) {
        continue;
      }

      const workflowDocument = workflowMap.get(
        `${context.endpoint.method} ${context.endpoint.path}`,
      );

      const fields = collectEndpointSearchFields({
        doc,
        pathItem,
        operation,
      });
      const pathTokens = tokenizeSearchText(path.replace(/[{}]/g, " "));
      const operationTokens = tokenizeSearchText(
        [
          context.endpoint.operationId,
          context.endpoint.summary,
          context.endpoint.description,
        ]
          .filter(Boolean)
          .join(" "),
      );
      const tagTokens = tokenizeSearchText(context.endpoint.tags.join(" "));
      const primaryText = normalizeSearchText(
        [
          context.endpoint.method,
          context.endpoint.path,
          context.endpoint.operationId,
          context.endpoint.summary,
          context.endpoint.description,
          context.endpoint.tags.join(" "),
        ]
          .filter(Boolean)
          .join(" "),
      );
      const parameterText = normalizeSearchText(fields.parameters.join(" "));
      const requestText = normalizeSearchText(fields.request.join(" "));
      const responseText = normalizeSearchText(fields.responses.join(" "));
      const searchText = [primaryText, parameterText, requestText, responseText]
        .filter(Boolean)
        .join(" ")
        .trim();

      documents.push({
        endpoint: context.endpoint,
        searchText,
        primaryTokens: tokenizeSearchText(primaryText),
        pathTokens,
        operationTokens,
        tagTokens,
        parameterTokens: tokenizeSearchText(parameterText),
        requestTokens: tokenizeSearchText(requestText),
        responseTokens: tokenizeSearchText(responseText),
        requestFieldDepths: toFieldDepthMap(fields.requestDescriptors),
        responseFieldDepths: toFieldDepthMap(fields.responseDescriptors),
        operationKind: workflowDocument?.operationKind ?? "action",
      });
    }
  }

  return documents.sort(
    (left, right) =>
      left.endpoint.path.localeCompare(right.endpoint.path) ||
      left.endpoint.method.localeCompare(right.endpoint.method),
  );
}

function collectEndpointSearchFields(input: {
  doc: OpenApiDocument;
  pathItem: JsonObject;
  operation: JsonObject;
}): {
  parameters: string[];
  request: string[];
  responses: string[];
  requestDescriptors: StructuredFieldDescriptor[];
  responseDescriptors: StructuredFieldDescriptor[];
} {
  const parameters = summarizeParameters(
    input.doc,
    input.pathItem,
    input.operation,
  ).flatMap((parameter) => [parameter.name, parameter.schema?.refName]);

  const requestDescriptors = collectRequestFieldDescriptors(
    input.doc,
    input.operation,
  );
  const request = new Set<string>();

  const requestBody = resolveMaybeRef(input.doc, input.operation.requestBody);
  if (isObject(requestBody) && isObject(requestBody.content)) {
    for (const contentType of Object.keys(requestBody.content)) {
      request.add(contentType);
    }
  }

  const formDataParameters = extractParametersArray(input.operation.parameters)
    .map((parameter) => resolveParameter(input.doc, parameter))
    .filter(
      (parameter): parameter is JsonObject =>
        isObject(parameter) && parameter.in === "formData",
    );
  for (const parameter of formDataParameters) {
    if (typeof parameter.name === "string") {
      request.add(parameter.name);
    }
  }

  for (const descriptor of requestDescriptors) {
    request.add(descriptor.fieldName);
    request.add(descriptor.fieldPath);
  }

  const responseDescriptors = collectResponseFieldDescriptors(
    input.doc,
    input.operation,
  );
  const responses = new Set<string>();
  const responseMap = isObject(input.operation.responses)
    ? input.operation.responses
    : {};
  for (const [status, responseValue] of Object.entries(responseMap)) {
    responses.add(status);
    const response = resolveMaybeRef(input.doc, responseValue);
    if (!isObject(response) || !isObject(response.content)) {
      continue;
    }

    for (const [contentType, mediaType] of Object.entries(response.content)) {
      responses.add(contentType);
      if (!isObject(mediaType)) {
        continue;
      }
    }
  }

  for (const descriptor of responseDescriptors) {
    responses.add(descriptor.fieldName);
    responses.add(descriptor.fieldPath);
  }

  return {
    parameters: parameters.filter((value): value is string => Boolean(value)),
    request: [...request],
    responses: [...responses],
    requestDescriptors,
    responseDescriptors,
  };
}

function buildWorkflowDocuments(
  doc: OpenApiDocument,
  documentUrl: string,
): WorkflowDocument[] {
  const paths = isObject(doc.paths) ? doc.paths : {};
  const documents: WorkflowDocument[] = [];

  for (const [path, pathItem] of Object.entries(paths)) {
    if (!isObject(pathItem)) {
      continue;
    }

    for (const method of HTTP_METHODS) {
      const operation = pathItem[method];
      if (!isObject(operation)) {
        continue;
      }

      const upperMethod = method.toUpperCase() as Uppercase<HttpMethod>;
      const context = getOperationContext(doc, upperMethod, path, documentUrl);
      if (!context) {
        continue;
      }

      const requestDescriptors = collectRequestFieldDescriptors(doc, operation);
      const responseDescriptors = collectResponseFieldDescriptors(
        doc,
        operation,
      );
      const resourceTokens = tokenizePathResources(path);
      const provisionalKind = inferOperationKind(context.endpoint, false);
      const isAuthEndpoint = isLikelyAuthEndpoint(
        context.endpoint,
        responseDescriptors,
      );
      const operationKind = isAuthEndpoint
        ? "auth"
        : inferOperationKind(context.endpoint, isAuthEndpoint);
      const resourceToken = inferPrimaryResourceToken(path);
      const isPublicEndpoint = isLikelyPublicEndpoint(context.endpoint);

      const requiredInputs: WorkflowSignal[] = [];
      const optionalInputs: WorkflowSignal[] = [];

      for (const parameter of context.endpoint.parameters) {
        const normalizedParameterName = normalizeIdentifier(parameter.name);
        if (
          parameter.in !== "path" &&
          !isLikelyWorkflowDependencyName(normalizedParameterName)
        ) {
          continue;
        }

        const signal = createWorkflowSignalFromParameter(
          parameter,
          resourceToken,
        );
        if (!signal) {
          continue;
        }

        if (parameter.in === "path" || parameter.required) {
          requiredInputs.push(signal);
        } else {
          optionalInputs.push(signal);
        }
      }

      for (const descriptor of requestDescriptors) {
        if (!isLikelyWorkflowDependencyName(descriptor.normalizedName)) {
          continue;
        }

        const signal = createWorkflowSignalFromField(
          descriptor,
          "request-body",
          resourceToken,
          operationKind,
        );
        if (descriptor.required) {
          requiredInputs.push(signal);
        } else {
          optionalInputs.push(signal);
        }
      }

      if (
        !isPublicEndpoint &&
        !isAuthEndpoint &&
        context.securityRequirements.some(
          (requirement) => requirement.length > 0,
        )
      ) {
        requiredInputs.push({
          name: "accessToken",
          normalizedName: "accesstoken",
          aliases: ["accesstoken", "token", "bearertoken"],
          source: "auth",
          required: true,
          depth: 0,
        });
      }

      const producedOutputs = [
        ...responseDescriptors.map((descriptor) =>
          createWorkflowSignalFromField(
            descriptor,
            "response-body",
            resourceToken,
            operationKind,
            isAuthEndpoint,
          ),
        ),
        ...inferImplicitWorkflowOutputs({
          endpoint: context.endpoint,
          operationKind,
          resourceToken,
          isAuthEndpoint,
        }),
      ];

      documents.push({
        key: `${context.endpoint.method} ${context.endpoint.path}`,
        endpoint: context.endpoint,
        operationKind: provisionalKind === "auth" ? "auth" : operationKind,
        isAuthEndpoint,
        resourceTokens,
        requiredInputs: dedupeWorkflowSignals(requiredInputs),
        optionalInputs: dedupeWorkflowSignals(optionalInputs),
        producedOutputs: dedupeWorkflowSignals(producedOutputs),
      });
    }
  }

  return documents.sort(
    (left, right) =>
      left.endpoint.path.localeCompare(right.endpoint.path) ||
      left.endpoint.method.localeCompare(right.endpoint.method),
  );
}

function collectRequestFieldDescriptors(
  doc: OpenApiDocument,
  operation: JsonObject,
): StructuredFieldDescriptor[] {
  const fields: StructuredFieldDescriptor[] = [];
  const requestBody = resolveMaybeRef(doc, operation.requestBody);

  if (isObject(requestBody) && isObject(requestBody.content)) {
    for (const mediaType of Object.values(requestBody.content)) {
      if (!isObject(mediaType)) {
        continue;
      }

      fields.push(
        ...collectSchemaFieldDescriptors({
          doc,
          schemaValue: mediaType.schema,
          ancestorRequired: true,
        }),
      );
    }

    return dedupeStructuredFields(fields);
  }

  const swaggerBodyParameter = extractParametersArray(operation.parameters)
    .map((parameter) => resolveParameter(doc, parameter))
    .find((parameter) => isObject(parameter) && parameter.in === "body");
  if (swaggerBodyParameter && isObject(swaggerBodyParameter)) {
    fields.push(
      ...collectSchemaFieldDescriptors({
        doc,
        schemaValue: swaggerBodyParameter.schema,
        ancestorRequired: swaggerBodyParameter.required === true,
      }),
    );
  }

  return dedupeStructuredFields(fields);
}

function collectResponseFieldDescriptors(
  doc: OpenApiDocument,
  operation: JsonObject,
): StructuredFieldDescriptor[] {
  const fields: StructuredFieldDescriptor[] = [];
  const responses = isObject(operation.responses) ? operation.responses : {};

  for (const responseValue of Object.values(responses)) {
    const response = resolveMaybeRef(doc, responseValue);
    if (!isObject(response) || !isObject(response.content)) {
      continue;
    }

    for (const mediaType of Object.values(response.content)) {
      if (!isObject(mediaType)) {
        continue;
      }

      fields.push(
        ...collectSchemaFieldDescriptors({
          doc,
          schemaValue: mediaType.schema,
          ancestorRequired: true,
        }),
      );
    }
  }

  return dedupeStructuredFields(fields);
}

function collectSchemaFieldPaths(input: {
  doc: OpenApiDocument;
  schemaValue: unknown;
  currentPath?: string;
  visitedRefs?: Set<string>;
}): string[] {
  const fields = collectSchemaFieldDescriptors({
    ...input,
    ancestorRequired: true,
  });
  return [
    ...new Set(fields.flatMap((field) => [field.fieldName, field.fieldPath])),
  ];
}

function collectSchemaFieldDescriptors(input: {
  doc: OpenApiDocument;
  schemaValue: unknown;
  currentPath?: string;
  visitedRefs?: Set<string>;
  ancestorRequired: boolean;
}): StructuredFieldDescriptor[] {
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

  const descriptors: StructuredFieldDescriptor[] = [];
  const properties = isObject(resolved.properties)
    ? resolved.properties
    : undefined;
  const requiredSet = new Set(readStringArray(resolved.required) ?? []);

  if (properties) {
    for (const [propertyName, propertySchema] of Object.entries(properties)) {
      const fieldPath = input.currentPath
        ? `${input.currentPath}.${propertyName}`
        : propertyName;
      const required =
        input.ancestorRequired &&
        (requiredSet.has(propertyName) ||
          isSchemaMarkedRequired(propertySchema));
      descriptors.push({
        fieldName: propertyName,
        fieldPath,
        normalizedName: normalizeIdentifier(propertyName),
        required,
        depth: measureFieldDepth(fieldPath),
      });

      descriptors.push(
        ...collectSchemaFieldDescriptors({
          ...input,
          schemaValue: propertySchema,
          currentPath: fieldPath,
          visitedRefs,
          ancestorRequired: required,
        }),
      );
    }
  }

  if (isObject(resolved.items)) {
    descriptors.push(
      ...collectSchemaFieldDescriptors({
        ...input,
        schemaValue: resolved.items,
        currentPath: input.currentPath ? `${input.currentPath}[]` : "[]",
        visitedRefs,
        ancestorRequired: input.ancestorRequired,
      }),
    );
  }

  for (const key of ["allOf", "oneOf", "anyOf"] as const) {
    const values = resolved[key];
    if (!Array.isArray(values)) {
      continue;
    }

    for (const schemaEntry of values) {
      descriptors.push(
        ...collectSchemaFieldDescriptors({
          ...input,
          schemaValue: schemaEntry,
          visitedRefs,
        }),
      );
    }
  }

  return dedupeStructuredFields(descriptors);
}

function isSchemaMarkedRequired(schemaValue: unknown): boolean {
  return isObject(schemaValue) && schemaValue.nullable === false;
}

function dedupeStructuredFields(
  descriptors: StructuredFieldDescriptor[],
): StructuredFieldDescriptor[] {
  const seen = new Set<string>();
  const deduped: StructuredFieldDescriptor[] = [];

  for (const descriptor of descriptors) {
    const key = `${descriptor.fieldPath}|${descriptor.required}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(descriptor);
  }

  return deduped;
}

function createWorkflowSignalFromParameter(
  parameter: ParameterSummary,
  resourceToken?: string,
): WorkflowSignal | undefined {
  if (!parameter.name) {
    return undefined;
  }

  return {
    name: parameter.name,
    normalizedName: normalizeIdentifier(parameter.name),
    aliases: buildSignalAliases(parameter.name, parameter.name, resourceToken),
    source:
      parameter.in === "path"
        ? "path-parameter"
        : parameter.in === "query"
          ? "query-parameter"
          : parameter.in === "header"
            ? "query-parameter"
            : "query-parameter",
    required: parameter.required,
    depth: 0,
  };
}

function createWorkflowSignalFromField(
  descriptor: StructuredFieldDescriptor,
  source: WorkflowSignal["source"],
  resourceToken: string | undefined,
  operationKind: OperationKind,
  isAuthEndpoint = false,
): WorkflowSignal {
  return {
    name: descriptor.fieldPath,
    normalizedName: descriptor.normalizedName,
    aliases: buildSignalAliases(
      descriptor.fieldName,
      descriptor.fieldPath,
      source === "response-body" && operationKind === "create"
        ? resourceToken
        : undefined,
      isAuthEndpoint,
    ),
    source,
    required: descriptor.required,
    depth: descriptor.depth,
  };
}

function inferImplicitWorkflowOutputs(input: {
  endpoint: EndpointDetail;
  operationKind: OperationKind;
  resourceToken?: string;
  isAuthEndpoint: boolean;
}): WorkflowSignal[] {
  const outputs: WorkflowSignal[] = [];

  if (input.isAuthEndpoint) {
    outputs.push({
      name: "accessToken",
      normalizedName: "accesstoken",
      aliases: ["accesstoken", "token", "bearertoken"],
      source: "response-body",
      required: false,
      depth: 0,
    });
  }

  if (input.operationKind === "create") {
    outputs.push({
      name: "id",
      normalizedName: "id",
      aliases: buildSignalAliases("id", "id", input.resourceToken),
      source: "response-body",
      required: false,
      depth: 0,
    });

    if (input.resourceToken) {
      const resourceId = `${input.resourceToken}Id`;
      outputs.push({
        name: resourceId,
        normalizedName: normalizeIdentifier(resourceId),
        aliases: buildSignalAliases(
          resourceId,
          resourceId,
          input.resourceToken,
        ),
        source: "response-body",
        required: false,
        depth: 0,
      });
    }
  }

  return outputs;
}

function buildSignalAliases(
  fieldName: string,
  fieldPath: string,
  resourceToken?: string,
  isAuthEndpoint = false,
): string[] {
  const aliases = new Set<string>();
  const normalizedField = normalizeIdentifier(fieldName);
  const normalizedPath = normalizeIdentifier(fieldPath.replace(/\[\]/g, " "));
  const leaf = normalizeIdentifier(
    fieldPath.replace(/\[\]/g, "").split(".").pop() ?? fieldName,
  );

  aliases.add(normalizedField);
  aliases.add(normalizedPath);
  aliases.add(leaf);

  if (resourceToken && isIdentityName(leaf)) {
    const suffix = leaf.endsWith("uuid")
      ? "uuid"
      : leaf.endsWith("slug")
        ? "slug"
        : "id";
    aliases.add(`${normalizeIdentifier(resourceToken)}${suffix}`);
  }

  if (isAuthEndpoint && isTokenLikeName(leaf)) {
    aliases.add("token");
    aliases.add("accesstoken");
    aliases.add("bearertoken");
  }

  return [...aliases].filter(Boolean);
}

function dedupeWorkflowSignals(signals: WorkflowSignal[]): WorkflowSignal[] {
  const seen = new Set<string>();
  const deduped: WorkflowSignal[] = [];

  for (const signal of signals) {
    const key = `${signal.source}|${signal.name}|${signal.required}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(signal);
  }

  return deduped;
}

function inferOperationKind(
  endpoint: EndpointDetail,
  isAuthEndpoint: boolean,
): OperationKind {
  if (isAuthEndpoint) {
    return "auth";
  }

  const tokens = tokenizeSearchText(
    [
      endpoint.operationId,
      endpoint.summary,
      endpoint.description,
      endpoint.path,
    ]
      .filter(Boolean)
      .join(" "),
  );
  const hasIdentifierPath = /\{[^}]+\}/.test(endpoint.path);

  switch (endpoint.method) {
    case "POST":
      if (
        tokens.some(
          (token) =>
            getSynonymTokens(token).includes("create") || token === "create",
        )
      ) {
        return "create";
      }
      return hasIdentifierPath ? "action" : "create";
    case "GET":
      return hasIdentifierPath ? "get" : "list";
    case "PUT":
    case "PATCH":
      return "update";
    case "DELETE":
      return "delete";
    default:
      return "action";
  }
}

function isLikelyAuthEndpoint(
  endpoint: EndpointDetail,
  responseDescriptors: StructuredFieldDescriptor[],
): boolean {
  const tokens = tokenizeSearchText(
    [
      endpoint.operationId,
      endpoint.summary,
      endpoint.description,
      endpoint.path,
    ]
      .filter(Boolean)
      .join(" "),
  );

  if (
    tokens.some((token) =>
      [
        "auth",
        "authenticate",
        "login",
        "signin",
        "token",
        "oauth",
        "session",
      ].includes(token),
    )
  ) {
    return true;
  }

  return responseDescriptors.some((descriptor) =>
    isTokenLikeName(descriptor.normalizedName),
  );
}

function isLikelyPublicEndpoint(endpoint: EndpointDetail): boolean {
  const text = [endpoint.summary, endpoint.description]
    .filter((value): value is string => typeof value === "string")
    .join(" ");

  return (
    /gerekli\s+permission\s*:\s*yok/iu.test(text) ||
    /herkese\s+açık(?:tır)?/iu.test(text) ||
    /public\s+endpoint/i.test(text) ||
    /authentication\s+not\s+required/i.test(text) ||
    /no\s+auth/i.test(text)
  );
}

function isTokenLikeName(value: string): boolean {
  return (
    value === "token" ||
    value === "accesstoken" ||
    value === "idtoken" ||
    value === "refreshtoken" ||
    value.endsWith("token")
  );
}

function isLikelyWorkflowDependencyName(value: string): boolean {
  return (
    isIdentityName(value) ||
    isTokenLikeName(value) ||
    value.endsWith("file") ||
    value.endsWith("fileid") ||
    value.endsWith("imageid") ||
    value.endsWith("attachmentid") ||
    value.endsWith("mediaid") ||
    value.endsWith("documentid") ||
    value.endsWith("parentid")
  );
}

function measureFieldDepth(fieldPath: string): number {
  return fieldPath.replace(/\[\]/g, "").split(".").filter(Boolean).length;
}

function toFieldDepthMap(
  descriptors: StructuredFieldDescriptor[],
): Record<string, number> {
  const depthMap: Record<string, number> = {};

  for (const descriptor of descriptors) {
    for (const token of [descriptor.fieldName, descriptor.fieldPath]) {
      const normalized = normalizeIdentifier(token.replace(/\[\]/g, " "));
      if (!normalized) {
        continue;
      }

      const current = depthMap[normalized];
      depthMap[normalized] =
        current === undefined
          ? descriptor.depth
          : Math.min(current, descriptor.depth);
    }
  }

  return depthMap;
}

function scoreSearchDocument(
  document: EndpointSearchDocument,
  searchTerms: Array<{ token: string; display: string; weight: number }>,
  normalizedPhrase: string,
  desiredOperationKinds: Set<OperationKind>,
):
  | {
      endpoint: EndpointSummary;
      score: number;
      matchedTerms: string[];
    }
  | undefined {
  const primary = new Set(document.primaryTokens);
  const pathTokens = new Set(document.pathTokens);
  const operationTokens = new Set(document.operationTokens);
  const tagTokens = new Set(document.tagTokens);
  const parameters = new Set(document.parameterTokens);
  const request = new Set(document.requestTokens);
  const responses = new Set(document.responseTokens);
  const matchedTerms = new Set<string>();
  let score = 0;

  for (const term of searchTerms) {
    const { token, display, weight } = term;

    if (pathTokens.has(token)) {
      score += 2.75 * weight;
      matchedTerms.add(display);
      continue;
    }

    if (operationTokens.has(token)) {
      score += 2.25 * weight;
      matchedTerms.add(display);
      continue;
    }

    if (tagTokens.has(token)) {
      score += 1.75 * weight;
      matchedTerms.add(display);
      continue;
    }

    if (primary.has(token)) {
      score +=
        token === document.endpoint.method.toLowerCase()
          ? 2.5 * weight
          : 1.6 * weight;
      matchedTerms.add(display);
      continue;
    }

    if (parameters.has(token)) {
      score += 1.5 * weight;
      matchedTerms.add(display);
      continue;
    }

    if (request.has(token)) {
      const depth = document.requestFieldDepths[token] ?? 1;
      score += Math.max(0.75, 1.4 - (depth - 1) * 0.15) * weight;
      matchedTerms.add(display);
      continue;
    }

    if (responses.has(token)) {
      const depth = document.responseFieldDepths[token] ?? 1;
      score += Math.max(0.6, 1.15 - (depth - 1) * 0.12) * weight;
      matchedTerms.add(display);
      continue;
    }

    if (document.searchText.includes(token)) {
      score += 0.35 * weight;
      matchedTerms.add(display);
    }
  }

  if (matchedTerms.size === 0) {
    return undefined;
  }

  let normalizedScore = score / Math.max(searchTerms.length, 1);
  if (desiredOperationKinds.has(document.operationKind)) {
    normalizedScore += 0.85;
  }
  if (normalizedPhrase && document.searchText.includes(normalizedPhrase)) {
    normalizedScore += 0.5;
  }

  return {
    endpoint: document.endpoint,
    score: Number(normalizedScore.toFixed(3)),
    matchedTerms: [...matchedTerms],
  };
}

function buildWorkflowSuggestion(
  resolved: ResolvedDocument,
  target: EndpointSummary,
  maxDepth: number,
): WorkflowSuggestion | undefined {
  const workflowMap = new Map(
    resolved.workflowDocuments.map((workflow) => [workflow.key, workflow]),
  );
  const targetKey = `${target.method} ${target.path}`;
  const targetWorkflow = workflowMap.get(targetKey);
  if (!targetWorkflow) {
    return undefined;
  }

  const orderedSteps: WorkflowDocument[] = [];
  const added = new Set<string>();
  const visiting = new Set<string>();
  const availableOutputs = new Set<string>();
  const stepReasons = new Map<string, string[]>();
  const coveredDependencies = new Set<string>();
  const missingDependencies = new Set<string>();

  const addStepReason = (key: string, reason: string) => {
    const reasons = stepReasons.get(key) ?? [];
    if (!reasons.includes(reason)) {
      reasons.push(reason);
    }
    stepReasons.set(key, reasons);
  };

  const hasAvailableDependency = (signal: WorkflowSignal): boolean =>
    signal.aliases.some((alias) => availableOutputs.has(alias));

  const registerOutputs = (workflow: WorkflowDocument) => {
    for (const output of workflow.producedOutputs) {
      for (const alias of output.aliases) {
        availableOutputs.add(alias);
      }
    }
  };

  const ensureWorkflow = (workflow: WorkflowDocument, depth: number) => {
    if (
      added.has(workflow.key) ||
      visiting.has(workflow.key) ||
      depth > maxDepth
    ) {
      return;
    }

    visiting.add(workflow.key);
    const dependencies = workflow.requiredInputs;

    for (const dependency of dependencies) {
      if (hasAvailableDependency(dependency)) {
        coveredDependencies.add(dependency.name);
        continue;
      }

      const candidate = findBestProducer(
        resolved.workflowDocuments,
        workflow,
        dependency,
        added,
        visiting,
      );

      if (!candidate) {
        missingDependencies.add(dependency.name);
        continue;
      }

      addStepReason(
        candidate.key,
        explainProducerMatch(candidate, dependency, workflow),
      );
      ensureWorkflow(candidate, depth + 1);

      if (
        hasAvailableDependency(dependency) ||
        producesDependency(candidate, dependency)
      ) {
        coveredDependencies.add(dependency.name);
      } else {
        missingDependencies.add(dependency.name);
      }
    }

    visiting.delete(workflow.key);

    if (!added.has(workflow.key)) {
      if (workflow.key === targetWorkflow.key) {
        addStepReason(workflow.key, "target endpoint");
      }
      orderedSteps.push(workflow);
      added.add(workflow.key);
      registerOutputs(workflow);
    }
  };

  ensureWorkflow(targetWorkflow, 0);

  const uniqueCovered = [...coveredDependencies].sort();
  const uniqueMissing = [...missingDependencies]
    .filter((dependency) => !coveredDependencies.has(dependency))
    .sort();
  const sortedSteps = topologicallyOrderWorkflows(orderedSteps);
  const steps = sortedSteps.map((workflow, index) => ({
    step: index + 1,
    method: workflow.endpoint.method,
    path: workflow.endpoint.path,
    operationId: workflow.endpoint.operationId,
    summary: workflow.endpoint.summary,
    operationKind: workflow.operationKind,
    reasons: stepReasons.get(workflow.key) ?? [],
    produces: workflow.producedOutputs.map((output) => output.name),
    consumes: workflow.requiredInputs.map((input) => input.name),
  }));

  const dependencyCount = uniqueCovered.length + uniqueMissing.length;
  const dependencyCoverage =
    dependencyCount === 0
      ? 1
      : uniqueCovered.length / Math.max(dependencyCount, 1);
  const stepPenalty = Math.max(0, (steps.length - 1) * 0.05);
  const confidence = Math.max(
    0.1,
    Number((dependencyCoverage - stepPenalty).toFixed(3)),
  );

  return {
    target,
    confidence,
    coveredDependencies: uniqueCovered,
    missingDependencies: uniqueMissing,
    steps,
  };
}

function findBestProducer(
  workflows: WorkflowDocument[],
  consumer: WorkflowDocument,
  dependency: WorkflowSignal,
  added: Set<string>,
  visiting: Set<string>,
): WorkflowDocument | undefined {
  let best:
    | {
        workflow: WorkflowDocument;
        score: number;
      }
    | undefined;

  for (const workflow of workflows) {
    if (workflow.key === consumer.key || visiting.has(workflow.key)) {
      continue;
    }

    const score = scoreProducerCandidate(workflow, consumer, dependency, added);
    if (score <= 0) {
      continue;
    }

    if (!best || score > best.score) {
      best = {
        workflow,
        score,
      };
    }
  }

  return best?.workflow;
}

function topologicallyOrderWorkflows(
  workflows: WorkflowDocument[],
): WorkflowDocument[] {
  const workflowMap = new Map(
    workflows.map((workflow) => [workflow.key, workflow]),
  );
  const orderMap = new Map(
    workflows.map((workflow, index) => [workflow.key, index]),
  );
  const edges = new Map<string, Set<string>>();
  const indegree = new Map<string, number>();

  for (const workflow of workflows) {
    edges.set(workflow.key, new Set<string>());
    indegree.set(workflow.key, 0);
  }

  for (const producer of workflows) {
    for (const consumer of workflows) {
      if (producer.key === consumer.key) {
        continue;
      }

      if (
        !consumer.requiredInputs.some((dependency) =>
          producesDependency(producer, dependency),
        )
      ) {
        continue;
      }

      const next = edges.get(producer.key);
      if (!next || next.has(consumer.key)) {
        continue;
      }

      next.add(consumer.key);
      indegree.set(consumer.key, (indegree.get(consumer.key) ?? 0) + 1);
    }
  }

  const queue = workflows
    .filter((workflow) => (indegree.get(workflow.key) ?? 0) === 0)
    .sort(
      (left, right) =>
        (orderMap.get(left.key) ?? 0) - (orderMap.get(right.key) ?? 0),
    );
  const sorted: WorkflowDocument[] = [];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      continue;
    }

    sorted.push(current);
    const nextKeys = [...(edges.get(current.key) ?? [])].sort(
      (left, right) => (orderMap.get(left) ?? 0) - (orderMap.get(right) ?? 0),
    );

    for (const nextKey of nextKeys) {
      const nextDegree = (indegree.get(nextKey) ?? 0) - 1;
      indegree.set(nextKey, nextDegree);
      if (nextDegree === 0) {
        const nextWorkflow = workflowMap.get(nextKey);
        if (nextWorkflow) {
          queue.push(nextWorkflow);
        }
      }
    }

    queue.sort(
      (left, right) =>
        (orderMap.get(left.key) ?? 0) - (orderMap.get(right.key) ?? 0),
    );
  }

  return sorted.length === workflows.length ? sorted : workflows;
}

function scoreProducerCandidate(
  producer: WorkflowDocument,
  consumer: WorkflowDocument,
  dependency: WorkflowSignal,
  added: Set<string>,
): number {
  if (
    producer.endpoint.method === "HEAD" ||
    producer.endpoint.method === "OPTIONS" ||
    producer.endpoint.method === "TRACE" ||
    producer.operationKind === "delete"
  ) {
    return 0;
  }

  if (!producer.isAuthEndpoint && producer.producedOutputs.length === 0) {
    return 0;
  }

  const dependencyAliases = new Set(dependency.aliases);
  const producerAliases = new Set(
    producer.producedOutputs.flatMap((output) => output.aliases),
  );
  const sharedAliases = [...dependencyAliases].filter((alias) =>
    producerAliases.has(alias),
  );
  const satisfiesAuthDependency =
    dependency.aliases.includes("accesstoken") &&
    (producer.isAuthEndpoint || producer.operationKind === "auth");

  if (sharedAliases.length === 0 && !satisfiesAuthDependency) {
    return 0;
  }

  let score = 0;

  if (sharedAliases.length > 0) {
    score += sharedAliases.length * 7;
  }

  if (satisfiesAuthDependency) {
    score += 10;
  }

  const consumerResources = new Set(consumer.resourceTokens);
  const producerResources = producer.resourceTokens.filter((token) =>
    consumerResources.has(token),
  );
  if (producerResources.length > 0) {
    score += producerResources.length * 2.5;
  }

  if (isPathRelated(producer.endpoint.path, consumer.endpoint.path)) {
    score += 1.5;
  }

  if (producer.operationKind === "create") {
    score += 2;
  } else if (
    producer.operationKind === "get" ||
    producer.operationKind === "list"
  ) {
    score -= 2;
  }

  if (added.has(producer.key)) {
    score += 0.5;
  }

  return score;
}

function producesDependency(
  workflow: WorkflowDocument,
  dependency: WorkflowSignal,
): boolean {
  return workflow.producedOutputs.some((output) =>
    output.aliases.some((alias) => dependency.aliases.includes(alias)),
  );
}

function explainProducerMatch(
  producer: WorkflowDocument,
  dependency: WorkflowSignal,
  consumer: WorkflowDocument,
): string {
  if (
    dependency.aliases.includes("accesstoken") &&
    (producer.isAuthEndpoint || producer.operationKind === "auth")
  ) {
    return `provides authentication token required before ${consumer.endpoint.method} ${consumer.endpoint.path}`;
  }

  const matchingOutput = producer.producedOutputs.find((output) =>
    output.aliases.some((alias) => dependency.aliases.includes(alias)),
  );
  if (matchingOutput) {
    return `produces ${matchingOutput.name} needed by ${consumer.endpoint.method} ${consumer.endpoint.path}`;
  }

  return `supports upstream dependency for ${consumer.endpoint.method} ${consumer.endpoint.path}`;
}

function buildSearchTerms(
  query: string,
): Array<{ token: string; display: string; weight: number }> {
  const baseTokens = tokenizeSearchText(query);
  const terms = new Map<
    string,
    { token: string; display: string; weight: number }
  >();

  for (const token of baseTokens) {
    terms.set(token, {
      token,
      display: token,
      weight: 1,
    });

    for (const synonym of getSynonymTokens(token)) {
      const existing = terms.get(synonym);
      if (!existing || existing.weight < 0.65) {
        terms.set(synonym, {
          token: synonym,
          display: token,
          weight: 0.65,
        });
      }
    }
  }

  return [...terms.values()];
}

function inferDesiredOperationKinds(
  searchTerms: Array<{ token: string; display: string; weight: number }>,
): Set<OperationKind> {
  const kinds = new Set<OperationKind>();

  for (const term of searchTerms) {
    const token = term.token;
    if (getSynonymTokens(token).includes("create") || token === "create") {
      kinds.add("create");
    }
    if (getSynonymTokens(token).includes("update") || token === "update") {
      kinds.add("update");
    }
    if (getSynonymTokens(token).includes("delete") || token === "delete") {
      kinds.add("delete");
    }
    if (getSynonymTokens(token).includes("list") || token === "list") {
      kinds.add("list");
    }
    if (getSynonymTokens(token).includes("get") || token === "get") {
      kinds.add("get");
    }
    if (getSynonymTokens(token).includes("auth") || token === "auth") {
      kinds.add("auth");
    }
  }

  return kinds;
}

function getSynonymTokens(token: string): string[] {
  for (const group of SEARCH_SYNONYM_GROUPS) {
    if ((group as readonly string[]).includes(token)) {
      return [...group];
    }
  }

  return [token];
}

function tokenizeSearchText(value: string): string[] {
  if (!value.trim()) {
    return [];
  }

  return [
    ...new Set(
      normalizeSearchText(value)
        .split(/\s+/)
        .filter((token) => token.length > 1 && !SEARCH_STOP_WORDS.has(token)),
    ),
  ];
}

function normalizeSearchText(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .toLowerCase();
}

function buildSpecId(documentUrl: string): string {
  return `spec_${createHash("sha256").update(documentUrl).digest("hex").slice(0, 16)}`;
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
  const pathEntry = findPathEntry(paths, path);

  if (!pathEntry) {
    return undefined;
  }

  const [matchedPath, pathItem] = pathEntry;

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
      path: matchedPath,
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

function findPathEntry(
  paths: Record<string, unknown>,
  path: string,
): [string, unknown] | undefined {
  if (path in paths) {
    return [path, paths[path]];
  }

  const normalizedPath = normalizeOperationPathInput(path);
  return Object.entries(paths).find(
    ([candidatePath]) =>
      normalizeOperationPathInput(candidatePath) === normalizedPath,
  );
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
      style: typeof resolved.style === "string" ? resolved.style : undefined,
      explode:
        typeof resolved.explode === "boolean" ? resolved.explode : undefined,
      allowReserved:
        typeof resolved.allowReserved === "boolean"
          ? resolved.allowReserved
          : undefined,
      collectionFormat:
        typeof resolved.collectionFormat === "string"
          ? resolved.collectionFormat
          : undefined,
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
  if (isLikelyPublicOperation(operation)) {
    return [];
  }

  if (Array.isArray(operation.security)) {
    return operation.security;
  }

  if (Array.isArray(doc.security)) {
    return doc.security;
  }

  return [];
}

function isLikelyPublicOperation(operation: JsonObject): boolean {
  const text = [operation.summary, operation.description]
    .filter((value): value is string => typeof value === "string")
    .join(" ");

  return (
    /gerekli\s+permission\s*:\s*yok/iu.test(text) ||
    /herkese\s+açık(?:tır)?/iu.test(text) ||
    /public\s+endpoint/i.test(text) ||
    /authentication\s+not\s+required/i.test(text) ||
    /no\s+auth/i.test(text)
  );
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

function normalizeOperationPathInput(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) {
    return "/";
  }

  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      return safeDecodePathname(url.pathname || "/");
    } catch {
      return trimmed;
    }
  }

  const withoutHash = trimmed.split("#", 1)[0] ?? "";
  const queryIndex = withoutHash.indexOf("?");
  const pathOnly =
    queryIndex >= 0 ? withoutHash.slice(0, queryIndex) : withoutHash;
  const normalized = pathOnly || "/";
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

function safeDecodePathname(pathname: string): string {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
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
    normalized.includes("openapi=true") ||
    normalized.includes("openapi=1") ||
    normalized.includes("swagger") ||
    normalized.includes("api-docs") ||
    normalized.endsWith(".json") ||
    normalized.endsWith(".yaml") ||
    normalized.endsWith(".yml")
  );
}

function inferPrimaryResourceToken(path: string): string | undefined {
  const segments = path
    .split("/")
    .filter(Boolean)
    .filter((segment) => !segment.startsWith("{") && !segment.endsWith("}"))
    .map((segment) => normalizeIdentifier(segment));

  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index];
    if (!segment || GENERIC_NON_RESOURCE_SEGMENTS.has(segment)) {
      continue;
    }

    if (
      segment.startsWith("sync") ||
      segment.startsWith("getby") ||
      segment.startsWith("getall")
    ) {
      continue;
    }

    return singularizeToken(segment);
  }

  return undefined;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
