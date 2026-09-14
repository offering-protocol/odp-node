export {};
import {
  PAYMENT_OPTIONS,
  parseAgentServiceDocument,
  type AuthenticationRequirement,
  type EnrollmentProtocol,
  type OdpOperation,
  type OperationDescriptor,
  type PaymentProtocol,
  type PaymentOption,
  type ServiceProtocols
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
}

export interface DirectorySearchRequest {
  query?: string;
  filters?: DirectoryServiceFilters;
  limit?: number;
}

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
}

export interface DirectorySearchPage extends Record<string, unknown> {
  items: DirectoryService[];
  next?: string;
  facets?: DirectoryFacets;
}

export interface DirectorySearchSequence {
  items: AsyncIterable<DirectoryService>;
  pages: AsyncIterable<DirectorySearchPage>;
}

export interface DirectorySuggestionRequest {
  prefix: string;
  limit?: number;
  signal?: AbortSignal;
}

export interface DirectoryClient {
  readonly environment: DirectoryEnvironment;
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
  constructor(
    readonly status: number,
    message: string,
    headers: Headers
  ) {
    super(message);
    this.name = "DirectoryRequestError";
    this.headers = new Headers(headers);
  }
}

const MAXIMUM_BYTES = 524_288;
const MAXIMUM_PAGES = 16;
const MEDIA_TYPE = "application/json";
const numberSources = new WeakMap<object, Map<string, string>>();
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
    searchServices(request = {}, iteration = {}) {
      const body = validateSearchRequest(request);
      const maxPages = boundedInteger(iteration.maxPages ?? MAXIMUM_PAGES, "maxPages", 1, 16);
      const maxItems = optionalInteger(iteration.maxItems, "maxItems", 1, 10_000);
      const pages = () => searchPages(body, maxPages, iteration.signal);
      return {
        pages: { [Symbol.asyncIterator]: pages },
        items: {
          async *[Symbol.asyncIterator]() {
            let count = 0;
            for await (const page of pages()) {
              for (const item of page.items) {
                if (maxItems !== undefined && count >= maxItems) return;
                count += 1;
                yield item;
              }
            }
          }
        }
      };
    },
    continueSearchServices(next, iteration = {}) {
      const reference = requireText(next, "next", 1, 2048);
      const maxPages = boundedInteger(iteration.maxPages ?? MAXIMUM_PAGES, "maxPages", 1, 16);
      const maxItems = optionalInteger(iteration.maxItems, "maxItems", 1, 10_000);
      const pages = () => searchPages({}, maxPages, iteration.signal, reference);
      return {
        pages: { [Symbol.asyncIterator]: pages },
        items: {
          async *[Symbol.asyncIterator]() {
            let count = 0;
            for await (const page of pages()) {
              for (const item of page.items) {
                if (maxItems !== undefined && count >= maxItems) return;
                count += 1;
                yield item;
              }
            }
          }
        }
      };
    },
    async suggestServices(request) {
      const prefix = requireText(request.prefix, "prefix", 1, 128);
      const limit = optionalInteger(request.limit, "limit", 1, 25);
      const url = new URL("/v1/services/suggestions", origin);
      url.searchParams.set("prefix", prefix);
      if (limit !== undefined) url.searchParams.set("limit", String(limit));
      const value = await requestJson(url, {
        method: "GET",
        ...(request.signal === undefined ? {} : { signal: request.signal })
      });
      return parseSuggestions(value);
    }
  };

  async function* searchPages(
    body: DirectorySearchRequest,
    maxPages: number,
    signal?: AbortSignal,
    continuation?: string
  ): AsyncGenerator<DirectorySearchPage> {
    let url =
      continuation === undefined
        ? new URL("/v1/services/search", origin)
        : continuationUrl(continuation, origin);
    let init: RequestInit =
      continuation === undefined
        ? {
            method: "POST",
            body: JSON.stringify(body),
            ...(signal === undefined ? {} : { signal })
          }
        : { method: "GET", ...(signal === undefined ? {} : { signal }) };
    for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
      const page = parseSearchPage(await requestJson(url, init));
      yield page;
      if (page.next === undefined) return;
      url = continuationUrl(page.next, origin);
      init = { method: "GET", ...(signal === undefined ? {} : { signal }) };
    }
  }

  async function requestJson(url: URL, init: RequestInit): Promise<unknown> {
    const headers = new Headers(init.headers);
    headers.set("accept", MEDIA_TYPE);
    if (init.body !== undefined) headers.set("content-type", MEDIA_TYPE);
    let current = url;
    let request = { ...init, headers, redirect: "manual" as const };
    let response: Response | undefined;
    for (let redirects = 0; redirects <= 5; redirects += 1) {
      response = await transport(current, request);
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      if (redirects === 5) throw new Error("Directory response exceeded its redirect limit");
      const location = response.headers.get("location");
      if (location === null) throw new Error("Directory redirect omitted Location");
      const next = new URL(location, current);
      if (next.origin !== origin) throw new Error("Directory redirect changed origin");
      if (
        response.status === 303 ||
        ((response.status === 301 || response.status === 302) && request.method === "POST")
      )
        request = { method: "GET", headers, redirect: "manual" };
      current = next;
    }
    if (response === undefined) throw new Error("Directory request produced no response");
    if (!response.ok) {
      const message = await boundedText(response).catch(() => "");
      throw new DirectoryRequestError(
        response.status,
        message === "" ? `Directory request failed with HTTP ${response.status}` : message,
        response.headers
      );
    }
    const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (mediaType !== MEDIA_TYPE)
      throw new TypeError("Directory response must use application/json");
    const text = await boundedText(response);
    try {
      return JSON.parse(text, preserveNumberSource);
    } catch {
      throw new TypeError("Directory response must contain valid JSON");
    }
  }
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

function validateFilters(filters: DirectoryServiceFilters): DirectoryServiceFilters {
  return {
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
    ...(filters.payments === undefined ? {} : { payments: parsePaymentFilters(filters.payments) })
  };
}

function parseSearchPage(value: unknown): DirectorySearchPage {
  const object = requireObject(value, "Directory search page");
  if (!Array.isArray(object["items"]) || object["items"].length > 100)
    throw new TypeError("Directory search page items are invalid");
  const items = object["items"].map(parseService);
  const next = optionalText(object["next"], "next", 2048);
  const facets = object["facets"] === undefined ? undefined : parseFacets(object["facets"]);
  return {
    ...object,
    items,
    ...(next === undefined ? {} : { next }),
    ...(facets === undefined ? {} : { facets })
  };
}

function parseService(value: unknown): DirectoryService {
  const object = requireObject(value, "Directory Service result");
  const serviceOrigin = requireText(object["service_origin"], "service_origin", 1, 2048);
  const url = new URL(serviceOrigin);
  if (url.protocol !== "https:" || url.origin !== serviceOrigin)
    throw new TypeError("Directory Service origin must be an HTTPS origin");
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
  const indexedAt = requireText(object["indexed_at"], "indexed_at", 1, 64);
  if (Number.isNaN(Date.parse(indexedAt))) throw new TypeError("indexed_at must be a date-time");
  const normalized = { ...object };
  delete normalized["protocols"];
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
        })
  };
}

function parseEnrollmentFilters(value: unknown): EnrollmentProtocol[] {
  return uniqueDescriptors(value, "enrollment", 1, parseEnrollment, ({ name }) => name);
}

function parseOperationFilters(value: unknown): NonNullable<DirectoryServiceFilters["operations"]> {
  return uniqueDescriptors(
    value,
    "operations",
    OPERATIONS.length,
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
    2,
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

function parseEnrollment(value: unknown): EnrollmentProtocol {
  const object = requireObject(value, "enrollment descriptor");
  if (Object.keys(object).length !== 1 || object["name"] !== "aep")
    throw new TypeError("enrollment descriptor is invalid");
  return { name: "aep" };
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
      Number.MAX_SAFE_INTEGER,
      numberSource(object, "count")
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

function parseFacet<Value extends string>(
  value: unknown,
  name: string,
  allowed?: readonly Value[]
): DirectoryFacet<Value>[] {
  if (!Array.isArray(value) || value.length > 100)
    throw new TypeError(`${name} facets are invalid`);
  return value.map((entry) => {
    const object = requireObject(entry, `${name} facet`);
    const facetValue = requireText(object["value"], `${name} facet value`, 1, 128) as Value;
    if (allowed !== undefined && !allowed.includes(facetValue))
      throw new TypeError(`${name} facet value is invalid`);
    const count = boundedInteger(
      object["count"],
      `${name} facet count`,
      0,
      Number.MAX_SAFE_INTEGER,
      numberSource(object, "count")
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

function parseSuggestions(value: unknown): string[] {
  const object = requireObject(value, "Directory suggestions");
  const items = object["items"];
  if (Array.isArray(items) && items.length === 0) return [];
  return uniqueText(items, "suggestions", 25, 128);
}

function continuationUrl(reference: string, origin: string): URL {
  const url = new URL(reference, origin);
  if (url.origin !== origin || url.username !== "" || url.password !== "")
    throw new TypeError("Directory continuation must remain on the canonical origin");
  return url;
}

async function boundedText(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAXIMUM_BYTES)
    throw new RangeError("Directory response exceeds its byte limit");
  const chunks: Uint8Array[] = [];
  let length = 0;
  if (response.body !== null)
    for await (const value of response.body as AsyncIterable<unknown>) {
      if (!(value instanceof Uint8Array))
        throw new TypeError("Directory response body yielded an invalid chunk");
      const chunk = value;
      length += chunk.byteLength;
      if (length > MAXIMUM_BYTES) throw new RangeError("Directory response exceeds its byte limit");
      chunks.push(chunk);
    }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
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

function boundedInteger(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
  source?: string
): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < minimum ||
    value > maximum ||
    (source !== undefined && !exactIntegerInRange(source, minimum, maximum))
  )
    throw new RangeError(`${name} must be an integer from ${minimum} through ${maximum}`);
  return value;
}

function exactIntegerInRange(source: string, minimum: number, maximum: number): boolean {
  const match = /^(-?)(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/u.exec(source);
  const sign = match?.[1];
  const integerPart = match?.[2];
  if (sign === undefined || integerPart === undefined) return false;
  const fraction = match?.[3] ?? "";
  let digits = (integerPart + fraction).replace(/^0+/u, "");
  if (digits === "") return minimum <= 0 && maximum >= 0;
  const exponentText = match?.[4];
  let exponent = 0;
  if (exponentText !== undefined) {
    const magnitude = exponentText.replace(/^[+-]?0*/u, "");
    if (magnitude.length > 6) return false;
    exponent = Number(exponentText);
  }
  const scale = exponent - fraction.length;
  if (scale < 0) {
    const trim = -scale;
    if (trim >= digits.length || !/^0+$/u.test(digits.slice(-trim))) return false;
    digits = digits.slice(0, -trim);
  } else {
    if (digits.length + scale > 16) return false;
    digits += "0".repeat(scale);
  }
  const value = BigInt(`${sign}${digits}`);
  return value >= BigInt(minimum) && value <= BigInt(maximum);
}

function numberSource(object: object, name: string): string | undefined {
  return numberSources.get(object)?.get(name);
}

function preserveNumberSource(
  this: object,
  name: string,
  value: unknown,
  context?: { source?: string }
): unknown {
  if (name === "count" && typeof value === "number" && context?.source !== undefined) {
    let sources = numberSources.get(this);
    if (sources === undefined) {
      sources = new Map<string, string>();
      numberSources.set(this, sources);
    }
    sources.set(name, context.source);
  }
  return value;
}
