import { validate } from "@hyperjump/json-schema/openapi-3-1";

import type { OdpCache } from "./cache.js";
import { requestSupportingJson, type OdpTransport } from "./transport.js";

const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const;

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

export interface OpenApiResolutionOptions {
  url: URL;
  operationId: string;
  transport: OdpTransport;
  cache?: OdpCache;
  signal?: AbortSignal;
}

export async function resolveOpenApiOperation(
  options: OpenApiResolutionOptions
): Promise<{ document: Record<string, unknown>; operation: Record<string, unknown> }> {
  const value = await requestSupportingJson({
    transport: options.transport,
    url: options.url,
    ...(options.cache === undefined ? {} : { cache: options.cache }),
    cachePartition: "anonymous",
    resourceClass: "openapi",
    fallbackTtlMs: 0,
    accept: "application/vnd.oai.openapi+json;version=3.1, application/json;q=0.9",
    mediaTypes: ["application/vnd.oai.openapi+json", "application/json"],
    maximumBytes: 1_048_576,
    // OFR-73 gives the OpenAPI Action document its own nesting allowance of 32, well above the 16
    // that applies to ODP documents; a real 3.1 document nests past 16 without difficulty.
    maximumDepth: 32,
    validate: (candidate) =>
      requireJsonObject(candidate, "ODP OpenAPI document must be a JSON object"),
    ...(options.signal === undefined ? {} : { signal: options.signal })
  });
  const document = requireJsonObject(value, "ODP OpenAPI document must be a JSON object");
  if (
    typeof document["openapi"] !== "string" ||
    !/^3\.1\.\d+(?:[-+].*)?$/u.test(document["openapi"])
  )
    throw new TypeError("ODP Action requires an OpenAPI 3.1 document");
  const validation = await validate(
    "https://spec.openapis.org/oas/3.1/schema-base",
    document,
    "BASIC"
  );
  if (
    !validation.valid &&
    (!validation.errors?.length ||
      !validation.errors.every(
        (error) =>
          error.keyword === "https://json-schema.org/keyword/pattern" &&
          error.absoluteKeywordLocation.startsWith(
            "https://spec.openapis.org/oas/3.1/schema#/$defs/components/"
          ) &&
          error.absoluteKeywordLocation.endsWith("/propertyNames/pattern") &&
          /^#\*\/components\/securitySchemes\/(?:[a-zA-Z0-9._-]|%20)+$/u.test(
            error.instanceLocation
          )
      ))
  )
    throw new TypeError("ODP Action OpenAPI document is invalid");
  const matches: Record<string, unknown>[] = [];
  // OFR-69 requires the document to hold *exactly one* matching Operation Object. OpenAPI 3.1
  // makes `paths` optional and lets Operation Objects live under `webhooks` and
  // `components.pathItems` too, so all three are searched: missing one would both fail to find a
  // legitimate operation and fail to notice a duplicate that makes the reference ambiguous.
  for (const container of ["paths", "webhooks"] as const)
    collectOperations(document[container], options.operationId, matches);
  const components = document["components"];
  if (typeof components === "object" && components !== null && !Array.isArray(components))
    collectOperations(
      (components as Record<string, unknown>)["pathItems"],
      options.operationId,
      matches
    );
  if (matches.length !== 1)
    throw new TypeError(`ODP Action operation_id ${options.operationId} must resolve exactly once`);
  const operation = matches[0];
  if (operation === undefined) throw new TypeError("ODP Action OpenAPI operation is unavailable");
  return { document: structuredClone(document), operation: structuredClone(operation) };
}

/** Collects every Operation Object under a Path Items container whose `operationId` matches. */
function collectOperations(
  container: unknown,
  operationId: string,
  matches: Record<string, unknown>[]
): void {
  if (typeof container !== "object" || container === null || Array.isArray(container)) return;
  for (const pathItem of Object.values(container as Record<string, unknown>)) {
    const item = pathItem as Record<string, unknown>;
    for (const method of METHODS) {
      const candidate = item[method];
      if (
        typeof candidate === "object" &&
        candidate !== null &&
        !Array.isArray(candidate) &&
        (candidate as Record<string, unknown>)["operationId"] === operationId
      )
        matches.push(candidate as Record<string, unknown>);
    }
  }
}

function requireJsonObject(value: unknown, message: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new TypeError(message);
  if (!isJson(value)) throw new TypeError(message);
  return value as JsonObject;
}

function isJson(value: unknown): value is Json {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return true;
  if (Array.isArray(value)) return value.every(isJson);
  return typeof value === "object" && Object.values(value as Record<string, unknown>).every(isJson);
}
