import {
  PAYMENT_OPTIONS,
  isLocalResourceIdentifier,
  parseAgentServiceDocument,
  type AuthenticationRequirement,
  type EnrollmentProtocol,
  type OdpOperation,
  type OperationDescriptor,
  type PaymentProtocol,
  type PaymentOption,
  type ServiceProtocols,
  type TrustProtocol
} from "@offering-protocol/core";

export const DIRECTORY_ORIGINS = Object.freeze({
  production: "https://api.inflowpay.ai",
  sandbox: "https://sandbox.inflowpay.ai"
});

export type DirectoryEnvironment = keyof typeof DIRECTORY_ORIGINS;
export type DirectoryTransport = typeof globalThis.fetch;

export interface DirectoryClientOptions {
  environment?: DirectoryEnvironment;
  transport?: DirectoryTransport;
}

export interface DirectoryServiceFilters {
  sources?: DirectorySourceType[];
  enrollment?: EnrollmentProtocol[];
  keywords?: string[];
  operations?: Array<{
    authentication?: AuthenticationRequirement;
    name: OdpOperation;
  }>;
  payments?: Array<{
    authentication?: PaymentProtocol["authentication"];
    name: PaymentProtocol["name"];
    options?: PaymentOption[];
  }>;
  trust?: TrustProtocol[];
}

export interface DirectorySearchRequest {
  query?: string;
  filters?: DirectoryServiceFilters;
  limit?: number;
}

export interface DirectoryResourceSearchRequest extends DirectorySearchRequest {
  types?: Array<"service" | "collection">;
}

interface DirectoryServiceReference extends Record<string, unknown> {
  service_id: string;
  service_origin: string;
  name?: string;
}

export type DirectorySourceType = "odp" | "openapi";

export interface DirectorySource extends Record<string, unknown> {
  type: string;
  url: string;
  x402_discovery: boolean;
}

export interface DirectoryIndexedService extends Record<string, unknown> {
  service_id: string;
  service_origin: string;
  source: DirectorySource;
  name: string;
  indexed_at: string;
  description?: string;
  documentation_url?: string;
  language?: string;
  localizations?: string[];
  keywords?: string[];
  operations?: OperationDescriptor[];
  protocols?: ServiceProtocols;
  status_url?: string;
  support_url?: string;
  website_url?: string;
}

export interface DirectoryPublisher extends Record<string, unknown> {
  publisher_id: string;
  name: string;
  website_url: string;
}

export interface DirectoryServiceResult extends Record<string, unknown> {
  type: "service";
  service: DirectoryIndexedService;
  indexed_at: string;
  publisher?: DirectoryPublisher | null;
}

export interface DirectoryCollectionResult extends Record<string, unknown> {
  type: "collection";
  service: DirectoryIndexedService;
  indexed_at: string;
  collection: {
    [key: string]: unknown;
    id: string;
    name: string;
    description?: string;
  };
}

export interface DirectoryUnknownResult {
  type: "unknown";
  resource_type: string;
  raw: Record<string, unknown>;
}

export type DirectoryResult =
  DirectoryServiceResult | DirectoryCollectionResult | DirectoryUnknownResult;

export interface DirectoryIterationOptions {
  maxItems?: number;
  maxPages?: number;
  signal?: AbortSignal;
}

export interface DirectoryService extends Record<string, unknown> {
  service_origin: string;
  name: string;
  description: string;
  documentation_url?: string;
  language: string;
  localizations: string[];
  keywords?: string[];
  operations: OperationDescriptor[];
  protocols?: ServiceProtocols;
  indexed_at: string;
  status_url?: string;
  support_url?: string;
  website_url?: string;
}

export interface DirectoryFacet<Value = string> {
  value: Value;
  count: number;
}

export interface DirectoryPaymentOptionFacetValue {
  name: PaymentProtocol["name"];
  option: PaymentOption;
}

export interface DirectoryFacets {
  enrollment?: DirectoryFacet<EnrollmentProtocol>[];
  keywords?: DirectoryFacet[];
  operations?: DirectoryFacet<OperationDescriptor>[];
  payments?: DirectoryFacet<PaymentProtocol>[];
  payment_options?: DirectoryFacet<DirectoryPaymentOptionFacetValue>[];
  trust?: DirectoryFacet<TrustProtocol>[];
}

export interface DirectoryIssue {
  /** Index of the rejected entry within the page's `items` array as the directory sent it. */
  index: number;
  message: string;
}

export interface DirectorySearchPage<Item = DirectoryService> extends Record<string, unknown> {
  items: Item[];
  next?: string;
  facets?: DirectoryFacets;
  /**
   * Entries the directory returned that this client could not validate. They are dropped from
   * `items` rather than failing the page: a directory is a discovery aid, not an authority, and one
   * stale entry must not make every other Service undiscoverable.
   */
  issues?: DirectoryIssue[];
}

export interface DirectorySearchSequence<Item = DirectoryService> {
  items: AsyncIterable<Item>;
  pages: AsyncIterable<DirectorySearchPage<Item>>;
}

export interface DirectorySuggestionRequest {
  filters?: DirectoryServiceFilters;
  prefix: string;
  limit?: number;
  signal?: AbortSignal;
}

export interface DirectoryClient {
  readonly environment: DirectoryEnvironment;
  search(
    request?: DirectoryResourceSearchRequest,
    options?: DirectoryIterationOptions
  ): DirectorySearchSequence<DirectoryResult>;
  continueSearch(
    next: string,
    options?: DirectoryIterationOptions
  ): DirectorySearchSequence<DirectoryResult>;
  suggest(request: DirectorySuggestionRequest): Promise<string[]>;
  searchServices(
    request?: DirectorySearchRequest,
    options?: DirectoryIterationOptions
  ): DirectorySearchSequence;
  continueSearchServices(
    next: string,
    options?: DirectoryIterationOptions
  ): DirectorySearchSequence;
  suggestServices(request: DirectorySuggestionRequest): Promise<string[]>;
}

export class DirectoryRequestError extends Error {
  readonly headers: Headers;
  /** Present so one retry helper can serve this and `OdpRequestError` alike. */
  readonly code: string;
  readonly retryable: boolean;
  constructor(
    readonly status: number,
    message: string,
    headers: Headers
  ) {
    super(message);
    this.name = "DirectoryRequestError";
    this.headers = new Headers(headers);
    this.code = "HTTP_ERROR";
    this.retryable = status === 429 || status >= 500;
  }
}

const MAXIMUM_BYTES = 524_288;
/** A directory page carries at most this many Services. */
const MAXIMUM_ITEMS_PER_PAGE = 100;
/** An error body is read only far enough to explain the failure, and never becomes a huge message. */
const MAXIMUM_ERROR_BYTES = 16_384;
const MAXIMUM_ERROR_MESSAGE = 2_048;
const MEDIA_TYPE = "application/json";
const PROBLEM_MEDIA_TYPE = "application/problem+json";
const MAXIMUM_SUGGESTIONS = 25;
const MAXIMUM_PAYMENT_FILTERS = 32;
const AUTHENTICATION_REQUIREMENTS = ["not-required", "optional", "required"] as const;
/** RFC 3339 `date-time`, which is what the directory contract means by a timestamp. */
const RFC_3339 = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})$/u;
/**
 * Service Document members this parser does not validate. They are stripped from the passthrough so
 * nothing on the result looks schema-checked when it is not.
 */
const UNVERIFIED_MEMBERS = [
  "branding",
  "http",
  "mcp",
  "odp_version",
  "payment_origins",
  "search_capabilities"
] as const;
const OPERATIONS = [
  "list-collections",
  "search-collections",
  "get-collection",
  "list-collection-offerings",
  "list-offerings",
  "search-offerings",
  "get-offering"
] as const satisfies readonly OdpOperation[];

export function createDirectoryClient(options: DirectoryClientOptions = {}): DirectoryClient {
  const environment = options.environment ?? "production";
  const origin = DIRECTORY_ORIGINS[environment];
  const transport = options.transport ?? globalThis.fetch;

  return {
    environment,
    search(request = {}, iteration = {}) {
      const body = validateResourceSearchRequest(request);
      const maxPages = optionalInteger(iteration.maxPages, "maxPages", 1, Number.MAX_SAFE_INTEGER);
      const maxItems = optionalInteger(iteration.maxItems, "maxItems", 1, 10_000);
      const pages = () =>
        searchPages("/v1/directory/search", parseResult, body, maxPages, iteration.signal);
      return { pages: { [Symbol.asyncIterator]: pages }, items: itemIterable(pages, maxItems) };
    },
    continueSearch(next, iteration = {}) {
      const reference = requireText(next, "next", 1, 2048);
      const maxPages = optionalInteger(iteration.maxPages, "maxPages", 1, Number.MAX_SAFE_INTEGER);
      const maxItems = optionalInteger(iteration.maxItems, "maxItems", 1, 10_000);
      const pages = () =>
        searchPages(
          "/v1/directory/search",
          parseResult,
          undefined,
          maxPages,
          iteration.signal,
          reference
        );
      return { pages: { [Symbol.asyncIterator]: pages }, items: itemIterable(pages, maxItems) };
    },
    suggest(request) {
      return suggestions("/v1/directory/suggestions", request, true);
    },
    searchServices(request = {}, iteration = {}) {
      const body = validateSearchRequest(request);
      const maxPages = optionalInteger(iteration.maxPages, "maxPages", 1, Number.MAX_SAFE_INTEGER);
      const maxItems = optionalInteger(iteration.maxItems, "maxItems", 1, 10_000);
      const pages = () =>
        searchPages("/v1/services/search", parseService, body, maxPages, iteration.signal);
      return { pages: { [Symbol.asyncIterator]: pages }, items: itemIterable(pages, maxItems) };
    },
    continueSearchServices(next, iteration = {}) {
      const reference = requireText(next, "next", 1, 2048);
      const maxPages = optionalInteger(iteration.maxPages, "maxPages", 1, Number.MAX_SAFE_INTEGER);
      const maxItems = optionalInteger(iteration.maxItems, "maxItems", 1, 10_000);
      const pages = () =>
        searchPages(
          "/v1/services/search",
          parseService,
          undefined,
          maxPages,
          iteration.signal,
          reference
        );
      return { pages: { [Symbol.asyncIterator]: pages }, items: itemIterable(pages, maxItems) };
    },
    suggestServices(request) {
      return suggestions("/v1/services/suggestions", request);
    }
  };

  async function suggestions(
    path: string,
    request: DirectorySuggestionRequest,
    mixed = false
  ): Promise<string[]> {
    const prefix = requireText(request.prefix, "prefix", 1, 128);
    const limit = optionalInteger(request.limit, "limit", 1, 25);
    const url = new URL(path, origin);
    if (!mixed && request.filters !== undefined)
      throw new TypeError("Service-only suggestions do not support filters.");
    const filters = request.filters === undefined ? undefined : validateFilters(request.filters);
    if (!mixed) {
      url.searchParams.set("prefix", prefix);
      if (limit !== undefined) url.searchParams.set("limit", String(limit));
    }
    const value = await requestJson(url, {
      method: mixed ? "POST" : "GET",
      ...(mixed
        ? {
            body: JSON.stringify({
              prefix,
              ...(limit === undefined ? {} : { limit }),
              ...(filters === undefined ? {} : { filters })
            })
          }
        : {}),
      ...(request.signal === undefined ? {} : { signal: request.signal })
    });
    return parseSuggestions(value);
  }

  async function* searchPages<Item>(
    path: string,
    parseItem: (value: unknown) => Item,
    body: DirectorySearchRequest | undefined,
    maxPages: number | undefined,
    signal?: AbortSignal,
    continuation?: string
  ): AsyncGenerator<DirectorySearchPage<Item>> {
    let url =
      continuation === undefined ? new URL(path, origin) : continuationUrl(continuation, origin);
    let init: RequestInit =
      body === undefined
        ? { method: "GET", ...(signal === undefined ? {} : { signal }) }
        : {
            method: "POST",
            body: JSON.stringify(body),
            ...(signal === undefined ? {} : { signal })
          };
    // Without a cycle check a directory that repeats a cursor would page forever now that the
    // traversal is no longer capped at 16.
    const visited = new Set<string>([String(url)]);
    for (let pageNumber = 0; ; pageNumber += 1) {
      const page = parseSearchPage(await requestJson(url, init), parseItem);
      yield page;
      if (page.next === undefined) return;
      // The caller's own bound ends the sequence cleanly; the last yielded page still carries
      // `next`, so a `pages` consumer can resume with `continueSearchServices`.
      if (maxPages !== undefined && pageNumber + 1 >= maxPages) return;
      url = continuationUrl(page.next, origin);
      if (visited.has(String(url))) throw new Error("Directory pagination loop detected");
      visited.add(String(url));
      init = { method: "GET", ...(signal === undefined ? {} : { signal }) };
    }
  }

  async function requestJson(url: URL, init: RequestInit): Promise<unknown> {
    const headers = new Headers(init.headers);
    headers.set("accept", MEDIA_TYPE);
    if (init.body !== undefined) headers.set("content-type", MEDIA_TYPE);
    let current = url;
    let request: RequestInit = { ...init, headers, redirect: "manual" };
    let response: Response | undefined;
    for (let redirects = 0; redirects <= 5; redirects += 1) {
      response = await transport(current, request);
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      if (redirects === 5) {
        await discard(response);
        throw new Error("Directory response exceeded its redirect limit");
      }
      const location = response.headers.get("location");
      if (location === null) {
        await discard(response);
        throw new Error("Directory redirect omitted Location");
      }
      const next = new URL(location, current);
      if (next.origin !== origin) {
        await discard(response);
        throw new Error("Directory redirect changed origin");
      }
      await discard(response);
      if (
        response.status === 303 ||
        ((response.status === 301 || response.status === 302) && request.method === "POST")
      ) {
        // Dropping the body is required; dropping everything else is not. Rebuilding the request
        // from scratch discarded the caller's abort signal, leaving the rest of the chain
        // uncancellable.
        const rewritten = new Headers(headers);
        rewritten.delete("content-type");
        const withoutBody: RequestInit = { ...init };
        delete withoutBody.body;
        request = { ...withoutBody, method: "GET", headers: rewritten, redirect: "manual" };
      }
      current = next;
    }
    if (response === undefined) throw new Error("Directory request produced no response");
    if (!response.ok) throw await requestFailure(response);
    const mediaType = mediaTypeOf(response);
    if (mediaType !== MEDIA_TYPE) {
      await discard(response);
      throw new TypeError("Directory response must use application/json");
    }
    const text = await boundedText(response, MAXIMUM_BYTES);
    try {
      return JSON.parse(text);
    } catch {
      throw new TypeError("Directory response must contain valid JSON");
    }
  }
}

/**
 * Builds the error for a failed request. The body is untrusted: it is read only when it claims to
 * be JSON, capped well below the response limit, and stripped of control characters before it
 * becomes an `Error.message` that will land in someone's log or terminal.
 */
async function requestFailure(response: Response): Promise<DirectoryRequestError> {
  const fallback = `Directory request failed with HTTP ${String(response.status)}`;
  const mediaType = mediaTypeOf(response);
  if (mediaType !== MEDIA_TYPE && mediaType !== PROBLEM_MEDIA_TYPE) {
    await discard(response);
    return new DirectoryRequestError(response.status, fallback, response.headers);
  }
  const text = await boundedText(response, MAXIMUM_ERROR_BYTES).catch(() => "");
  const detail = errorDetail(text);
  return new DirectoryRequestError(
    response.status,
    detail === "" ? fallback : `${fallback}: ${detail}`,
    response.headers
  );
}

/** Extracts a short, printable explanation from an error body. */
function errorDetail(text: string): string {
  let candidate = text;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      const object = parsed as Record<string, unknown>;
      const preferred = [object["detail"], object["title"], object["message"]].find(
        (value) => typeof value === "string" && value !== ""
      );
      if (typeof preferred === "string") candidate = preferred;
    }
  } catch {
    // A body that is not JSON after all still yields a sanitized excerpt.
  }
  // Strip C0/C1 controls so a response cannot inject terminal escapes into a log line.
  const printable = candidate.replace(/[\u0000-\u001f\u007f-\u009f]+/gu, " ").trim();
  return printable.length > MAXIMUM_ERROR_MESSAGE
    ? `${printable.slice(0, MAXIMUM_ERROR_MESSAGE)}…`
    : printable;
}

function mediaTypeOf(response: Response): string | undefined {
  return response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
}

/** Releases an unread body so a streaming transport does not pin the connection. */
async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // A body already consumed or errored needs no release.
  }
}

/** Yields each item, stopping the instant the caller's budget is met. */
function itemIterable<Item>(
  pages: () => AsyncGenerator<DirectorySearchPage<Item>>,
  maximum: number | undefined
): AsyncIterable<Item> {
  return {
    async *[Symbol.asyncIterator]() {
      let count = 0;
      for await (const page of pages()) {
        for (const item of page.items) {
          count += 1;
          yield item;
          // Checking before the yield let the enclosing loop pull another page whenever the
          // budget fell exactly on a page boundary.
          if (maximum !== undefined && count >= maximum) return;
        }
      }
    }
  };
}

function validateSearchRequest(request: DirectorySearchRequest): DirectorySearchRequest {
  const query =
    request.query === undefined ? undefined : requireText(request.query, "query", 1, 512);
  const limit = optionalInteger(request.limit, "limit", 1, 100);
  const filters = request.filters === undefined ? undefined : validateFilters(request.filters);
  return {
    ...(query === undefined ? {} : { query }),
    ...(filters === undefined ? {} : { filters }),
    ...(limit === undefined ? {} : { limit })
  };
}

function validateResourceSearchRequest(
  request: DirectoryResourceSearchRequest
): DirectoryResourceSearchRequest {
  const base = validateSearchRequest(request);
  if (request.types === undefined) return base;
  if (
    !Array.isArray(request.types) ||
    request.types.length === 0 ||
    request.types.length > 2 ||
    new Set(request.types).size !== request.types.length ||
    request.types.some((type) => type !== "service" && type !== "collection")
  )
    throw new TypeError("types must contain distinct service or collection values");
  return { ...base, types: [...request.types] };
}

function parseResult(value: unknown): DirectoryResult {
  const object = requireObject(value, "Directory result");
  const type = requireText(object["type"], "type", 1, 128);
  if (type !== "service" && type !== "collection")
    return { type: "unknown", resource_type: type, raw: { ...object } };
  const serviceObject = requireObject(object["service"], "service");
  const source = parseSource(serviceObject["source"]);
  const service: DirectoryIndexedService = {
    ...(source.type === "odp" ? parseService(serviceObject) : parseImportedService(serviceObject)),
    service_id: requireText(serviceObject["service_id"], "service_id", 1, 128),
    source
  };
  const indexedAt = parseIndexedAt(object["indexed_at"]);
  if (type === "service") {
    const publisher =
      object["publisher"] == null ? object["publisher"] : parsePublisher(object["publisher"]);
    return {
      ...object,
      type,
      service,
      indexed_at: indexedAt,
      ...(publisher === undefined ? {} : { publisher })
    };
  }
  const collection = requireObject(object["collection"], "collection");
  const id = requireText(collection["id"], "collection.id", 1, 128);
  if (!isLocalResourceIdentifier(id))
    throw new TypeError("collection.id must be a local resource identifier");
  const name = requireText(collection["name"], "collection.name", 1, 128);
  const description = collection["description"];
  if (description !== undefined && (typeof description !== "string" || description.length > 1024))
    throw new TypeError("collection.description is invalid");
  return {
    ...object,
    type,
    service,
    indexed_at: indexedAt,
    collection: { ...collection, id, name, ...(description === undefined ? {} : { description }) }
  };
}

function parseSource(value: unknown): DirectorySource {
  const object = requireObject(value, "source");
  const type = requireText(object["type"], "source.type", 1, 128);
  const address = requireText(object["url"], "source.url", 1, 2048);
  const url = new URL(address);
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    address.includes("#") ||
    isPrivateHost(url.hostname)
  )
    throw new TypeError(
      "source.url must be a public HTTPS document URL without credentials or a fragment"
    );
  const discovery = object["x402_discovery"];
  if (typeof discovery !== "boolean")
    throw new TypeError("source.x402_discovery must be a boolean");
  return { ...object, type, url: address, x402_discovery: discovery };
}

function parseImportedService(
  object: Record<string, unknown>
): Pick<DirectoryIndexedService, "service_origin" | "name" | "indexed_at"> &
  Record<string, unknown> {
  const reference = parseServiceReference(object);
  const normalized = { ...object };
  for (const member of [...UNVERIFIED_MEMBERS, "operations", "protocols"])
    delete normalized[member];
  for (const field of [
    "description",
    "documentation_url",
    "language",
    "status_url",
    "support_url",
    "website_url"
  ]) {
    if (object[field] !== undefined && typeof object[field] !== "string")
      throw new TypeError(`${field} must be a string`);
  }
  for (const field of ["keywords", "localizations"]) {
    const value = object[field];
    if (value !== undefined) {
      if (!Array.isArray(value)) throw new TypeError(`${field} must be an array of strings`);
      const entries: unknown[] = value;
      normalized[field] = entries.map((item) => {
        if (typeof item !== "string") throw new TypeError(`${field} must be an array of strings`);
        return item;
      });
    }
  }
  const protocols =
    object["protocols"] === undefined ? undefined : parseImportedProtocols(object["protocols"]);
  return {
    ...normalized,
    service_origin: reference.service_origin,
    name: requireText(object["name"], "name", 1, 128),
    indexed_at: parseIndexedAt(object["indexed_at"]),
    ...(protocols === undefined ? {} : { protocols })
  };
}

function parseImportedProtocols(value: unknown): ServiceProtocols {
  const object = requireObject(value, "protocols");
  const enrollment = recognizedDescriptors(object["enrollment"], ["aep"], parseEnrollment);
  const payments = recognizedDescriptors(object["payments"], ["mpp", "x402"], parsePayment);
  const trust = recognizedDescriptors(object["trust"], ["tap"], parseTrust);
  const result: ServiceProtocols = {};
  if (enrollment[0] !== undefined) result.enrollment = [enrollment[0]];
  if (trust[0] !== undefined) result.trust = [trust[0]];
  if (payments[0] !== undefined)
    result.payments = payments[1] === undefined ? [payments[0]] : [payments[0], payments[1]];
  return result;
}

function recognizedDescriptors<Value>(
  value: unknown,
  names: string[],
  parse: (value: unknown) => Value
): Value[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError("protocol descriptors must be an array");
  const result: Value[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const descriptor = requireObject(entry, "protocol descriptor");
    const name = requireText(descriptor["name"], "protocol name", 1, 128);
    if (names.includes(name)) {
      if (seen.has(name)) throw new TypeError("protocol names must be unique");
      seen.add(name);
      result.push(parse(entry));
    }
  }
  return result;
}

function parsePublisher(value: unknown): DirectoryPublisher {
  const object = requireObject(value, "publisher");
  const website = requireText(object["website_url"], "website_url", 1, 512);
  const url = new URL(website);
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "")
    throw new TypeError("Publisher website must be an HTTPS URL without credentials");
  return {
    ...object,
    publisher_id: requireText(object["publisher_id"], "publisher_id", 1, 128),
    name: requireText(object["name"], "name", 1, 128),
    website_url: website
  };
}

function parseServiceReference(value: unknown): DirectoryServiceReference {
  const object = requireObject(value, "service");
  const serviceOrigin = requireText(object["service_origin"], "service_origin", 1, 2048);
  const url = parseOrigin(serviceOrigin);
  if (url.protocol !== "https:" || url.origin !== serviceOrigin || isPrivateHost(url.hostname))
    throw new TypeError("Service origin must be a public HTTPS origin");
  const name = optionalText(object["name"], "name", 128);
  return {
    ...object,
    service_id: requireText(object["service_id"], "service_id", 1, 128),
    service_origin: serviceOrigin,
    ...(name === undefined ? {} : { name })
  };
}

function parseIndexedAt(value: unknown): string {
  const indexedAt = requireText(value, "indexed_at", 1, 64);
  if (!RFC_3339.test(indexedAt) || Number.isNaN(Date.parse(indexedAt)))
    throw new TypeError("indexed_at must be an RFC 3339 date-time");
  return indexedAt;
}

function validateFilters(filters: DirectoryServiceFilters): DirectoryServiceFilters {
  return {
    ...(filters.sources === undefined
      ? {}
      : { sources: uniqueEnums(filters.sources, "sources", ["odp", "openapi"] as const) }),
    ...(filters.keywords === undefined
      ? {}
      : { keywords: uniqueText(filters.keywords, "keywords", 32, 64) }),
    ...(filters.enrollment === undefined
      ? {}
      : { enrollment: parseEnrollmentFilters(filters.enrollment) }),
    ...(filters.operations === undefined
      ? {}
      : {
          operations: parseOperationFilters(filters.operations)
        }),
    ...(filters.payments === undefined ? {} : { payments: parsePaymentFilters(filters.payments) }),
    ...(filters.trust === undefined ? {} : { trust: parseTrustFilters(filters.trust) })
  };
}

function parseSearchPage<Item>(
  value: unknown,
  parseItem: (value: unknown) => Item
): DirectorySearchPage<Item> {
  const object = requireObject(value, "Directory search page");
  if (!Array.isArray(object["items"]) || object["items"].length > MAXIMUM_ITEMS_PER_PAGE)
    throw new TypeError("Directory search page items are invalid");
  // One stale or nonconformant entry used to reject the whole page, which killed the generator and
  // made every other Service in the result set undiscoverable. Drop the entry, keep the page, and
  // tell the caller what was skipped.
  const items: Item[] = [];
  const issues: DirectoryIssue[] = [];
  object["items"].forEach((entry, index) => {
    try {
      items.push(parseItem(entry));
    } catch (error) {
      issues.push({
        index,
        message: error instanceof Error ? error.message : "Directory Service result is invalid"
      });
    }
  });
  const next = optionalText(object["next"], "next", 2048);
  const facets = object["facets"] === undefined ? undefined : parseFacets(object["facets"]);
  return {
    ...object,
    items,
    ...(next === undefined ? {} : { next }),
    ...(facets === undefined ? {} : { facets }),
    ...(issues.length === 0 ? {} : { issues })
  };
}

function parseService(value: unknown): DirectoryService {
  const object = requireObject(value, "Directory Service result");
  const serviceOrigin = requireText(object["service_origin"], "service_origin", 1, 2048);
  const url = parseOrigin(serviceOrigin);
  if (url.protocol !== "https:" || url.origin !== serviceOrigin)
    throw new TypeError("Directory Service origin must be an HTTPS origin");
  // A public directory has no business pointing an Agent at a loopback or private host. The Agent's
  // default transport also refuses these, but that guarantee should not depend on which transport
  // the consumer happens to install.
  if (isPrivateHost(url.hostname))
    throw new TypeError("Directory Service origin must not be a private or loopback host");
  const document = parseAgentServiceDocument({
    odp_version: "1.0",
    name: object["name"],
    description: object["description"],
    ...(object["documentation_url"] === undefined
      ? {}
      : { documentation_url: object["documentation_url"] }),
    language: object["language"],
    localizations: object["localizations"],
    ...(object["keywords"] === undefined ? {} : { keywords: object["keywords"] }),
    operations: object["operations"],
    http: { endpoint_base: "/" },
    ...(object["protocols"] === undefined ? {} : { protocols: object["protocols"] }),
    ...(object["status_url"] === undefined ? {} : { status_url: object["status_url"] }),
    ...(object["support_url"] === undefined ? {} : { support_url: object["support_url"] }),
    ...(object["website_url"] === undefined ? {} : { website_url: object["website_url"] })
  });
  const indexedAt = parseIndexedAt(object["indexed_at"]);
  const normalized = { ...object };
  // `protocols` is validated and reinstated below, but only when something survives filtering, so
  // the raw copy has to go first or an all-unknown block would pass straight through.
  delete normalized["protocols"];
  // Unknown members are passed through for forward compatibility, but Service Document members this
  // parser deliberately does not validate must not ride along looking as if they had been: `http`
  // in particular is a real field a consumer could build request URLs from.
  for (const member of UNVERIFIED_MEMBERS) delete normalized[member];
  return {
    ...normalized,
    service_origin: serviceOrigin,
    name: document.name,
    description: document.description,
    ...(document.documentation_url === undefined
      ? {}
      : { documentation_url: document.documentation_url }),
    language: document.language,
    localizations: document.localizations,
    operations: document.operations,
    indexed_at: indexedAt,
    ...(document.keywords === undefined ? {} : { keywords: document.keywords }),
    ...(document.protocols === undefined ? {} : { protocols: document.protocols }),
    ...(document.status_url === undefined ? {} : { status_url: document.status_url }),
    ...(document.support_url === undefined ? {} : { support_url: document.support_url }),
    ...(document.website_url === undefined ? {} : { website_url: document.website_url })
  };
}

function parseFacets(value: unknown): DirectoryFacets {
  const object = requireObject(value, "Directory facets");
  return {
    ...(object["keywords"] === undefined
      ? {}
      : { keywords: parseFacet(object["keywords"], "keywords") }),
    ...(object["enrollment"] === undefined
      ? {}
      : { enrollment: parseDescriptorFacet(object["enrollment"], "enrollment", parseEnrollment) }),
    ...(object["payments"] === undefined
      ? {}
      : { payments: parseDescriptorFacet(object["payments"], "payments", parsePayment) }),
    ...(object["payment_options"] === undefined
      ? {}
      : {
          payment_options: parseDescriptorFacet(
            object["payment_options"],
            "payment_options",
            parsePaymentOptionFacet
          )
        }),
    ...(object["operations"] === undefined
      ? {}
      : {
          operations: parseDescriptorFacet(object["operations"], "operations", parseOperation)
        }),
    ...(object["trust"] === undefined
      ? {}
      : { trust: parseDescriptorFacet(object["trust"], "trust", parseTrust) })
  };
}

function parseEnrollmentFilters(value: unknown): EnrollmentProtocol[] {
  return uniqueDescriptors(value, "enrollment", 1, parseEnrollment, ({ name }) => name);
}

function parseOperationFilters(value: unknown): NonNullable<DirectoryServiceFilters["operations"]> {
  return uniqueDescriptors(
    value,
    "operations",
    // Every operation may be filtered once per authentication value, so the cap is the number of
    // distinct filters the identity below can express, not the number of operations.
    OPERATIONS.length * AUTHENTICATION_REQUIREMENTS.length,
    (entry) => {
      const object = requireObject(entry, "operation filter");
      const name = requireEnum(object["name"], "operation name", OPERATIONS);
      const authentication =
        object["authentication"] === undefined
          ? undefined
          : requireEnum(object["authentication"], "operation authentication", [
              "not-required",
              "optional",
              "required"
            ] as const);
      if (Object.keys(object).some((key) => !["authentication", "name"].includes(key)))
        throw new TypeError("operation filter contains unknown fields");
      return { name, ...(authentication === undefined ? {} : { authentication }) };
    },
    ({ authentication, name }) => `${name}\u0000${authentication ?? ""}`
  );
}

function parsePaymentFilters(value: unknown): NonNullable<DirectoryServiceFilters["payments"]> {
  return uniqueDescriptors(
    value,
    "payments",
    // Two protocols, each expressible per authentication value and per option subset.
    MAXIMUM_PAYMENT_FILTERS,
    (entry) => {
      const object = requireObject(entry, "payment filter");
      const name = requireEnum(object["name"], "payment name", ["mpp", "x402"] as const);
      const authentication =
        object["authentication"] === undefined
          ? undefined
          : requireEnum(object["authentication"], "payment authentication", [
              "not-required",
              "required"
            ] as const);
      const options =
        object["options"] === undefined
          ? undefined
          : uniqueEnums(object["options"], "payment options", PAYMENT_OPTIONS);
      if (Object.keys(object).some((key) => !["authentication", "name", "options"].includes(key)))
        throw new TypeError("payment filter contains unknown fields");
      return {
        name,
        ...(authentication === undefined ? {} : { authentication }),
        ...(options === undefined ? {} : { options })
      };
    },
    ({ authentication, name, options }) =>
      `${name}\u0000${authentication ?? ""}\u0000${options?.join("\u0000") ?? ""}`
  );
}

function parseTrustFilters(value: unknown): NonNullable<DirectoryServiceFilters["trust"]> {
  return uniqueDescriptors(value, "trust", 1, parseTrust, ({ name }) => name);
}

function parseEnrollment(value: unknown): EnrollmentProtocol {
  const object = requireObject(value, "enrollment descriptor");
  if (Object.keys(object).length !== 1 || object["name"] !== "aep")
    throw new TypeError("enrollment descriptor is invalid");
  return { name: "aep" };
}

function parseTrust(value: unknown): TrustProtocol {
  const object = requireObject(value, "trust descriptor");
  if (Object.keys(object).length !== 1 || object["name"] !== "tap")
    throw new TypeError("trust descriptor is invalid");
  return { name: "tap" };
}

function parseOperation(value: unknown): OperationDescriptor {
  const object = requireObject(value, "operation descriptor");
  if (Object.keys(object).sort().join(",") !== "authentication,name")
    throw new TypeError("operation descriptor is invalid");
  return {
    authentication: requireEnum(object["authentication"], "operation authentication", [
      "not-required",
      "optional",
      "required"
    ] as const),
    name: requireEnum(object["name"], "operation name", OPERATIONS)
  };
}

function parsePayment(value: unknown): PaymentProtocol {
  const object = requireObject(value, "payment descriptor");
  if (Object.keys(object).some((key) => !["authentication", "name", "options"].includes(key)))
    throw new TypeError("payment descriptor is invalid");
  const options =
    object["options"] === undefined
      ? undefined
      : uniqueEnums(object["options"], "payment options", PAYMENT_OPTIONS);
  return {
    authentication: requireEnum(object["authentication"], "payment authentication", [
      "not-required",
      "required"
    ] as const),
    name: requireEnum(object["name"], "payment name", ["mpp", "x402"] as const),
    ...(options === undefined ? {} : { options })
  };
}

function parsePaymentOptionFacet(value: unknown): {
  name: PaymentProtocol["name"];
  option: PaymentOption;
} {
  const object = requireObject(value, "payment option facet");
  if (Object.keys(object).sort().join(",") !== "name,option")
    throw new TypeError("payment option facet is invalid");
  return {
    name: requireEnum(object["name"], "payment option protocol", ["mpp", "x402"] as const),
    option: requireEnum(object["option"], "payment option", PAYMENT_OPTIONS)
  };
}

function parseDescriptorFacet<Value>(
  value: unknown,
  name: string,
  parse: (value: unknown) => Value
): DirectoryFacet<Value>[] {
  if (!Array.isArray(value) || value.length > 100)
    throw new TypeError(`${name} facets are invalid`);
  return value.map((entry) => {
    const object = requireObject(entry, `${name} facet`);
    const count = boundedInteger(
      object["count"],
      `${name} facet count`,
      0,
      Number.MAX_SAFE_INTEGER
    );
    return { value: parse(object["value"]), count };
  });
}

function uniqueDescriptors<Value>(
  value: unknown,
  name: string,
  maximum: number,
  parse: (value: unknown) => Value,
  identity: (value: Value) => string
): Value[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > maximum)
    throw new TypeError(`${name} filters are invalid`);
  const parsed = value.map(parse);
  if (new Set(parsed.map(identity)).size !== parsed.length)
    throw new TypeError(`${name} filters must be unique`);
  return parsed;
}

function parseFacet(value: unknown, name: string): DirectoryFacet[] {
  if (!Array.isArray(value) || value.length > 100)
    throw new TypeError(`${name} facets are invalid`);
  return value.map((entry) => {
    const object = requireObject(entry, `${name} facet`);
    const facetValue = requireText(object["value"], `${name} facet value`, 1, 128);
    const count = boundedInteger(
      object["count"],
      `${name} facet count`,
      0,
      Number.MAX_SAFE_INTEGER
    );
    return { value: facetValue, count };
  });
}

function requireEnum<Value extends string>(
  value: unknown,
  name: string,
  allowed: readonly Value[]
): Value {
  if (typeof value !== "string" || !allowed.includes(value as Value))
    throw new TypeError(`${name} is invalid`);
  return value as Value;
}

function uniqueEnums<Value extends string>(
  value: unknown,
  name: string,
  allowed: readonly Value[]
): Value[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > allowed.length)
    throw new TypeError(`${name} are invalid`);
  const values = value.map((item) => requireEnum(item, name, allowed));
  if (new Set(values).size !== values.length) throw new TypeError(`${name} must be unique`);
  return values;
}

/**
 * The request `limit` is optional, so the server's own default decides how many suggestions come
 * back. Bounding and de-duplicating is the client's job; asserting a limit it never sent is not.
 */
function parseSuggestions(value: unknown): string[] {
  const object = requireObject(value, "Directory suggestions");
  const items = object["items"];
  if (!Array.isArray(items)) throw new TypeError("suggestions is invalid");
  const unique = new Set<string>();
  for (const item of items) {
    unique.add(requireText(item, "suggestions", 1, 128));
    if (unique.size === MAXIMUM_SUGGESTIONS) break;
  }
  return [...unique];
}

function continuationUrl(reference: string, origin: string): URL {
  const url = new URL(reference, origin);
  if (url.origin !== origin || url.username !== "" || url.password !== "")
    throw new TypeError("Directory continuation must remain on the canonical origin");
  return url;
}

async function boundedText(response: Response, maximum: number): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximum) {
    await discard(response);
    throw new RangeError("Directory response exceeds its byte limit");
  }
  const chunks: Uint8Array[] = [];
  let length = 0;
  const stream: ByteStream | null = response.body;
  const reader = stream === null ? undefined : stream.getReader();
  if (reader !== undefined)
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        const chunk = part.value;
        if (chunk === undefined) continue;
        length += chunk.byteLength;
        if (length > maximum) {
          await reader.cancel();
          throw new RangeError("Directory response exceeds its byte limit");
        }
        chunks.push(chunk);
      }
    } finally {
      reader.releaseLock();
    }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function parseOrigin(value: string): URL {
  try {
    return new URL(value);
  } catch {
    throw new TypeError("Directory Service origin must be an absolute URL");
  }
}

/** Syntactic check only: hosts that can never legitimately be a public Service origin. */
function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host.startsWith("[")) {
    const address = host.slice(1, -1);
    return (
      address === "::1" ||
      address === "::" ||
      address.startsWith("fc") ||
      address.startsWith("fd") ||
      address.startsWith("fe8") ||
      address.startsWith("fe9") ||
      address.startsWith("fea") ||
      address.startsWith("feb")
    );
  }
  const octets = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(host);
  if (octets === null) return false;
  const [first, second] = [Number(octets[1]), Number(octets[2])];
  if (first === 10 || first === 127 || first === 0) return true;
  if (first === 172 && second >= 16 && second <= 31) return true;
  if (first === 192 && second === 168) return true;
  if (first === 169 && second === 254) return true;
  return first === 100 && second >= 64 && second <= 127;
}

/**
 * Structural view of a response body. The runtime types it as `ReadableStream<any>`, which would
 * leak `any` into the read loop; matching on shape keeps it typed without a cast.
 */
interface ByteStream {
  getReader(): {
    read(): Promise<{ done: boolean; value?: Uint8Array | undefined }>;
    cancel(): Promise<void>;
    releaseLock(): void;
  };
}

function requireObject(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new TypeError(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function requireText(value: unknown, name: string, minimum: number, maximum: number): string {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum)
    throw new TypeError(`${name} is invalid`);
  if (value.trim() === "") throw new TypeError(`${name} is invalid`);
  return value;
}

function optionalText(value: unknown, name: string, maximum: number): string | undefined {
  return value === undefined ? undefined : requireText(value, name, 1, maximum);
}

function uniqueText(
  value: unknown,
  name: string,
  maximumItems: number,
  maximumLength: number
): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > maximumItems)
    throw new TypeError(`${name} is invalid`);
  const values = value.map((item) => requireText(item, name, 1, maximumLength));
  if (new Set(values).size !== values.length) throw new TypeError(`${name} must be unique`);
  return values;
}

function optionalInteger(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number
): number | undefined {
  return value === undefined ? undefined : boundedInteger(value, name, minimum, maximum);
}

function boundedInteger(value: unknown, name: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum)
    throw new RangeError(`${name} must be an integer from ${minimum} through ${maximum}`);
  return value;
}
