import CachePolicy from "http-cache-semantics";

import {
  deriveServiceOrigin,
  parseAgentServiceDocument,
  type EnrollmentProtocol,
  type OperationDescriptor,
  type PaymentProtocol,
  type ServiceDocument,
  type TrustProtocol
} from "@offering-protocol/core";

import type { OdpCache, OdpCacheRecord } from "./cache.js";
import { createDefaultTransport, DestinationPolicyError } from "./network.js";
import type { OdpTransport } from "./transport.js";

const ODP_MEDIA_TYPE = "application/odp+json";
const ODP_WELL_KNOWN_PATH = "/.well-known/odp";
const SERVICE_DOCUMENT_MAX_BYTES = 65_536;
const SERVICE_DOCUMENT_MAX_DEPTH = 8;
const DEFAULT_FALLBACK_TTL_MS = 4 * 60 * 60 * 1000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export interface OdpServiceCapabilities {
  enrollment: EnrollmentProtocol[];
  operations: OperationDescriptor[];
  payments: PaymentProtocol[];
  trust: TrustProtocol[];
}

export interface ServiceInspection {
  document: ServiceDocument;
  requestedUrl: URL;
  finalUrl: URL;
  serviceOrigin: string;
  freshness: "fresh" | "revalidated" | "fetched";
  capabilities: OdpServiceCapabilities;
}

export interface InspectServiceOptions {
  serviceUrl: string | URL;
  acceptLanguage?: string;
  cache?: OdpCache;
  /**
   * Isolates cached Service Documents by authentication context. Two clients reaching one Service
   * with different credentials must not share a cache entry (CCH-05, CCH-06).
   */
  cachePartition?: string;
  fallbackTtlMs?: number;
  fetch?: OdpTransport;
  allowLocalNetwork?: boolean;
  maxRedirects?: number;
  signal?: AbortSignal;
}

export type OdpInspectionErrorCode =
  | "aborted"
  | "blocked_destination"
  | "http_error"
  | "invalid_json"
  | "invalid_media_type"
  | "invalid_redirect"
  | "response_too_large"
  | "validation_failed";

export class OdpInspectionError extends Error {
  readonly code: OdpInspectionErrorCode;
  readonly status?: number;

  constructor(message: string, code: OdpInspectionErrorCode, status?: number, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "OdpInspectionError";
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

const flights = new WeakMap<OdpCache, Map<string, Promise<ServiceInspection>>>();
const transportIds = new WeakMap<OdpTransport, string>();
let nextTransportId = 0;

function transportIdentity(transport: OdpTransport | undefined): string {
  if (transport === undefined) return "default";
  const existing = transportIds.get(transport);
  if (existing !== undefined) return existing;
  nextTransportId += 1;
  const assigned = `t${String(nextTransportId)}`;
  transportIds.set(transport, assigned);
  return assigned;
}

/**
 * Two calls share an in-flight inspection only when every input that can change the outcome is
 * identical. The transport is part of that: a caller-supplied one carries its own credentials,
 * destination policy and redirect behaviour.
 */
function flightKey(options: InspectServiceOptions, requestedUrl: URL): string {
  return [
    String(requestedUrl),
    options.acceptLanguage ?? "",
    options.cachePartition ?? "",
    transportIdentity(options.fetch),
    String(options.allowLocalNetwork ?? false),
    String(options.maxRedirects ?? 5)
  ].join("\u0000");
}

function cloneInspection(inspection: ServiceInspection): ServiceInspection {
  return {
    ...inspection,
    document: structuredClone(inspection.document),
    requestedUrl: new URL(String(inspection.requestedUrl)),
    finalUrl: new URL(String(inspection.finalUrl)),
    capabilities: {
      enrollment: [...inspection.capabilities.enrollment],
      operations: [...inspection.capabilities.operations],
      payments: [...inspection.capabilities.payments],
      trust: [...inspection.capabilities.trust]
    }
  };
}

export async function inspectService(options: InspectServiceOptions): Promise<ServiceInspection> {
  const serviceOrigin = deriveServiceOrigin(options.serviceUrl);
  const requestedUrl = new URL(ODP_WELL_KNOWN_PATH, serviceOrigin);
  const cache = options.cache;
  if (cache === undefined || options.signal !== undefined)
    return fetchInspection(options, requestedUrl, serviceOrigin);

  const key = flightKey(options, requestedUrl);
  const active = flights.get(cache) ?? new Map<string, Promise<ServiceInspection>>();
  flights.set(cache, active);
  const existing = active.get(key);
  // Each caller gets its own object: `capabilities` exposes live arrays that one caller must not be
  // able to mutate out from under another.
  if (existing !== undefined) return cloneInspection(await existing);
  const flight = fetchInspection(options, requestedUrl, serviceOrigin).finally(() =>
    active.delete(key)
  );
  active.set(key, flight);
  return cloneInspection(await flight);
}

async function fetchInspection(
  options: InspectServiceOptions,
  requestedUrl: URL,
  serviceOrigin: string
): Promise<ServiceInspection> {
  const requestHeaders = requestHeaderRecord(options.acceptLanguage);
  const key = cacheKey(requestedUrl, options.acceptLanguage, options.cachePartition);
  let cached = await options.cache?.get("service-document", key);
  let cachePolicy = cached === undefined ? undefined : restorePolicy(cached);
  if (cached !== undefined && cachePolicy === undefined) {
    await options.cache?.delete("service-document", key);
    cached = undefined;
  }
  // SEC-16 / SVC-87: `finalUrl` comes out of a cache the caller supplies and may be persistent or
  // shared. Never fetch it without re-checking that it is still on the Service Origin — otherwise a
  // poisoned or stale record repoints every future inspection at an attacker-chosen URL.
  if (cached !== undefined && !isServiceOriginUrl(cached.finalUrl, serviceOrigin)) {
    await options.cache?.delete("service-document", key);
    cached = undefined;
    cachePolicy = undefined;
  }
  const policyRequest = {
    url: cached?.finalUrl ?? String(requestedUrl),
    method: "GET",
    headers: requestHeaders
  };
  if (cached !== undefined && cachePolicy?.satisfiesWithoutRevalidation(policyRequest) === true) {
    try {
      return inspectionFrom(
        cached.value,
        requestedUrl,
        new URL(cached.finalUrl),
        serviceOrigin,
        "fresh"
      );
    } catch {
      await options.cache?.delete("service-document", key);
      cached = undefined;
      cachePolicy = undefined;
    }
  }

  const headers =
    cachePolicy === undefined ? requestHeaders : cachePolicy.revalidationHeaders(policyRequest);
  const revalidationRequest = { ...policyRequest, headers };
  const response = await fetchWithRedirects(
    options,
    new URL(cached?.finalUrl ?? requestedUrl),
    headers,
    serviceOrigin
  );

  if (response.response.status === 304) {
    if (cached === undefined || cachePolicy === undefined) {
      throw new OdpInspectionError(
        "ODP Service Document returned 304 without a cached representation.",
        "http_error",
        304
      );
    }
    const revalidated = cachePolicy.revalidatedPolicy(
      revalidationRequest,
      responseMetadata(response.response)
    );
    // `revalidatedPolicy().modified` is `status !== 304`, so it is always false here. `matches` is
    // the meaningful field, but it is only conclusive when the 304 carried a validator of its own;
    // a bare 304 is legitimate and must still be honoured.
    if (suppliesValidator(response.response) && !revalidated.matches) {
      await options.cache?.delete("service-document", key);
      throw new OdpInspectionError(
        "ODP Service Document returned an unusable revalidation response.",
        "http_error",
        304
      );
    }
    const record = {
      ...cached,
      finalUrl: String(response.finalUrl),
      policy: revalidated.policy.toObject()
    };
    await persist(options.cache, record, revalidated.policy.storable());
    return inspectionFrom(
      cached.value,
      requestedUrl,
      response.finalUrl,
      serviceOrigin,
      "revalidated"
    );
  }

  if (!response.response.ok) {
    throw new OdpInspectionError(
      `ODP Service Document failed with HTTP ${response.response.status}.`,
      "http_error",
      response.response.status
    );
  }
  requireMediaType(response.response);
  const bytes = await readBounded(response.response, SERVICE_DOCUMENT_MAX_BYTES);
  const document = parseDocument(bytes);
  const policyResponse = withFallbackFreshness(
    responseMetadata(response.response),
    options.fallbackTtlMs ?? DEFAULT_FALLBACK_TTL_MS
  );
  const policy = new CachePolicy(
    { url: String(response.finalUrl), method: "GET", headers: requestHeaders },
    policyResponse,
    { shared: false }
  );
  const record: OdpCacheRecord<ServiceDocument> = {
    resourceClass: "service-document",
    key,
    url: String(requestedUrl),
    finalUrl: String(response.finalUrl),
    value: document,
    policy: policy.toObject()
  };
  await persist(options.cache, record, policy.storable());
  return inspectionFrom(document, requestedUrl, response.finalUrl, serviceOrigin, "fetched");
}

async function fetchWithRedirects(
  options: InspectServiceOptions,
  initialUrl: URL,
  headers: CachePolicy.Headers,
  serviceOrigin: string
): Promise<{ response: Response; finalUrl: URL }> {
  const fetchImpl = options.fetch ?? createDefaultTransport(options.allowLocalNetwork);
  if (typeof fetchImpl !== "function")
    throw new TypeError("ODP inspection requires a fetch implementation.");
  const maximum = options.maxRedirects ?? 5;
  if (!Number.isInteger(maximum) || maximum < 0 || maximum > 5) {
    throw new RangeError("maxRedirects must be an integer from 0 through 5");
  }
  let current = initialUrl;
  try {
    for (let redirects = 0; ; redirects += 1) {
      const response = await fetchImpl(current, {
        method: "GET",
        headers: headersForFetch(headers),
        redirect: "manual",
        ...(options.signal === undefined ? {} : { signal: options.signal })
      });
      if (!REDIRECT_STATUSES.has(response.status)) return { response, finalUrl: current };
      if (redirects >= maximum) {
        throw new OdpInspectionError(
          "ODP Service Document exceeded its redirect limit.",
          "invalid_redirect"
        );
      }
      const location = response.headers.get("location");
      if (location === null) {
        throw new OdpInspectionError(
          "ODP Service Document redirect omitted Location.",
          "invalid_redirect"
        );
      }
      const next = new URL(location, current);
      if (next.origin !== serviceOrigin || next.protocol !== current.protocol) {
        throw new OdpInspectionError(
          "ODP Service Document redirect changed origin or scheme.",
          "invalid_redirect"
        );
      }
      current = next;
    }
  } catch (error) {
    if (error instanceof OdpInspectionError) throw error;
    if (isAbortError(error) || options.signal?.aborted === true)
      throw new OdpInspectionError(
        "ODP Service Document request was aborted.",
        "aborted",
        undefined,
        error
      );
    const rejection =
      error instanceof DestinationPolicyError
        ? error
        : error instanceof Error && error.cause instanceof DestinationPolicyError
          ? error.cause
          : undefined;
    if (rejection !== undefined)
      throw new OdpInspectionError(
        `ODP Service Document request was rejected: ${rejection.message}`,
        "blocked_destination",
        undefined,
        error
      );
    throw new OdpInspectionError(
      "ODP Service Document could not be fetched.",
      "http_error",
      undefined,
      error
    );
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/** True when a 304 carried a validator of its own, making a `matches` result conclusive. */
function suppliesValidator(response: Response): boolean {
  return response.headers.get("etag") !== null || response.headers.get("last-modified") !== null;
}

function isServiceOriginUrl(value: string, serviceOrigin: string): boolean {
  try {
    return new URL(value).origin === serviceOrigin;
  } catch {
    return false;
  }
}

function requestHeaderRecord(acceptLanguage?: string): CachePolicy.Headers {
  return {
    accept: ODP_MEDIA_TYPE,
    ...(acceptLanguage === undefined ? {} : { "accept-language": acceptLanguage })
  };
}

function cacheKey(url: URL, acceptLanguage?: string, cachePartition?: string): string {
  return `${cachePartition ?? "public"}\u0000${String(url)}\u0000${acceptLanguage ?? ""}`;
}

function headersForFetch(headers: CachePolicy.Headers): Headers {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined) result.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  return result;
}

function responseMetadata(response: Response): CachePolicy.HttpResponse {
  return { status: response.status, headers: Object.fromEntries(response.headers.entries()) };
}

function withFallbackFreshness(
  response: CachePolicy.HttpResponse,
  fallbackTtlMs: number
): CachePolicy.HttpResponse {
  if (!Number.isFinite(fallbackTtlMs) || fallbackTtlMs < 0) {
    throw new RangeError("fallbackTtlMs must be a non-negative finite number");
  }
  const headers = { ...response.headers };
  const control = String(headers["cache-control"] ?? "").toLowerCase();
  const explicit =
    headers["expires"] !== undefined ||
    /(?:^|,)\s*(?:max-age|s-maxage|no-cache|no-store)\b/u.test(control);
  if (!explicit) {
    const fallback = `max-age=${Math.floor(fallbackTtlMs / 1000)}`;
    const original = headers["cache-control"];
    headers["cache-control"] = control.length === 0 ? fallback : `${String(original)}, ${fallback}`;
  }
  return { ...response, headers };
}

function requireMediaType(response: Response): void {
  const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== ODP_MEDIA_TYPE) {
    throw new OdpInspectionError(
      "ODP Service Document response media type is invalid.",
      "invalid_media_type"
    );
  }
}

async function readBounded(response: Response, maximum: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximum) {
    throw new OdpInspectionError(
      "ODP Service Document response is too large.",
      "response_too_large"
    );
  }
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    length += part.value.byteLength;
    if (length > maximum) {
      await reader.cancel();
      throw new OdpInspectionError(
        "ODP Service Document response is too large.",
        "response_too_large"
      );
    }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function parseDocument(bytes: Uint8Array): ServiceDocument {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new OdpInspectionError("ODP Service Document contains malformed JSON.", "invalid_json");
  }
  if (nestingDepth(value) > SERVICE_DOCUMENT_MAX_DEPTH) {
    throw new OdpInspectionError(
      "ODP Service Document exceeds the nesting-depth limit.",
      "validation_failed"
    );
  }
  try {
    return parseAgentServiceDocument(value);
  } catch {
    throw new OdpInspectionError("ODP Service Document validation failed.", "validation_failed");
  }
}

/**
 * Container nesting measured from the top-level value (ERR-18): `{}` and `{"a":1}` are both depth 1,
 * `{"a":{"b":1}}` is depth 2. A scalar is a value held by a container, not a level of its own —
 * counting it made the effective Service Document limit 7 containers rather than 8 (SVC-83).
 */
function nestingDepth(value: unknown): number {
  if (typeof value !== "object" || value === null) return 0;
  let maximum = 0;
  const pending: Array<{ depth: number; value: object }> = [{ depth: 1, value }];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    maximum = Math.max(maximum, current.depth);
    const children = Array.isArray(current.value)
      ? (current.value as unknown[])
      : Object.values(current.value as Record<string, unknown>);
    for (const child of children)
      if (typeof child === "object" && child !== null)
        pending.push({ depth: current.depth + 1, value: child });
  }
  return maximum;
}

function restorePolicy(record: OdpCacheRecord): CachePolicy | undefined {
  try {
    return CachePolicy.fromObject(record.policy);
  } catch {
    return undefined;
  }
}

async function persist(
  cache: OdpCache | undefined,
  record: OdpCacheRecord,
  storable: boolean
): Promise<void> {
  if (cache === undefined) return;
  if (storable) await cache.set(record);
  else await cache.delete(record.resourceClass, record.key);
}

function inspectionFrom(
  value: unknown,
  requestedUrl: URL,
  finalUrl: URL,
  serviceOrigin: string,
  freshness: ServiceInspection["freshness"]
): ServiceInspection {
  let document: ServiceDocument;
  try {
    document = parseAgentServiceDocument(structuredClone(value));
  } catch {
    throw new OdpInspectionError(
      "Cached ODP Service Document validation failed.",
      "validation_failed"
    );
  }
  return {
    document,
    requestedUrl,
    finalUrl,
    serviceOrigin,
    freshness,
    capabilities: {
      enrollment: [...(document.protocols?.enrollment ?? [])],
      operations: [...document.operations],
      payments: [...(document.protocols?.payments ?? [])],
      trust: [...(document.protocols?.trust ?? [])]
    }
  };
}
