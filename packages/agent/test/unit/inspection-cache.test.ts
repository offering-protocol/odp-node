import { describe, expect, it, vi } from "vitest";

import { createInMemoryOdpCache, type OdpCache, type OdpCacheRecord } from "../../src/cache.js";
import { inspectService, OdpInspectionError } from "../../src/inspection.js";
import { DestinationPolicyError } from "../../src/network.js";
import type { OdpTransport } from "../../src/transport.js";

const document = {
  odp_version: "1.0",
  name: "Example",
  description: "Example catalog",
  language: "en",
  localizations: ["en"],
  operations: [
    { authentication: "not-required", name: "list-offerings" },
    { authentication: "not-required", name: "get-offering" }
  ],
  http: { endpoint_base: "/odp" }
};

function odpResponse(value: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/odp+json", ...headers }
  });
}

function inspect(
  transport: OdpTransport,
  overrides: Partial<Parameters<typeof inspectService>[0]> = {}
) {
  return inspectService({ serviceUrl: "https://example.com", fetch: transport, ...overrides });
}

async function failureOf(promise: Promise<unknown>): Promise<OdpInspectionError> {
  return (await promise.catch((cause: unknown) => cause)) as OdpInspectionError;
}

describe("Service Document caching", () => {
  it("isolates cached documents by partition", async () => {
    const cache = createInMemoryOdpCache();
    let calls = 0;
    const transport: OdpTransport = vi.fn(() => {
      calls += 1;
      return Promise.resolve(odpResponse(document, { "cache-control": "max-age=60" }));
    });
    await inspect(transport, { cache, cachePartition: "agent-a" });
    await inspect(transport, { cache, cachePartition: "agent-b" });
    await inspect(transport, { cache, cachePartition: "agent-a" });
    // An authenticated document stored by one context must never be read back by another.
    expect(calls).toBe(2);
  });

  it("discards a cached record whose final URL is no longer on the Service Origin", async () => {
    const cache = createInMemoryOdpCache();
    const fetched: string[] = [];
    const transport: OdpTransport = vi.fn((url: URL) => {
      fetched.push(String(url));
      return Promise.resolve(odpResponse(document, { "cache-control": "max-age=60" }));
    });
    await inspect(transport, { cache, cachePartition: "public" });
    const key = await findRecord(cache);
    // A persistent or shared cache is caller-supplied; a record repointed off-origin used to be
    // fetched without any further check, making every later inspection follow it.
    await cache.set({ ...key, finalUrl: "http://169.254.169.254/latest/meta-data/" });
    await inspect(transport, { cache, cachePartition: "public" });
    expect(fetched).toEqual([
      "https://example.com/.well-known/odp",
      "https://example.com/.well-known/odp"
    ]);
  });

  it("discards a cached record whose final URL cannot be parsed", async () => {
    const cache = createInMemoryOdpCache();
    let calls = 0;
    const transport: OdpTransport = vi.fn(() => {
      calls += 1;
      return Promise.resolve(odpResponse(document, { "cache-control": "max-age=60" }));
    });
    await inspect(transport, { cache, cachePartition: "public" });
    const record = await findRecord(cache);
    await cache.set({ ...record, finalUrl: "not a url" });
    await inspect(transport, { cache, cachePartition: "public" });
    expect(calls).toBe(2);
  });

  it("rejects a 304 when nothing is cached to revalidate", async () => {
    const transport: OdpTransport = vi.fn(() =>
      Promise.resolve(new Response(null, { status: 304 }))
    );
    const failure = await failureOf(inspect(transport, { cache: createInMemoryOdpCache() }));
    expect(failure.code).toBe("http_error");
    expect(failure.status).toBe(304);
  });

  it("refuses a 304 that confirms a validator the cache does not hold", async () => {
    const cache = createInMemoryOdpCache();
    let calls = 0;
    const transport: OdpTransport = vi.fn(() => {
      calls += 1;
      if (calls === 1)
        return Promise.resolve(
          odpResponse(document, { "cache-control": "max-age=0", etag: '"v1"' })
        );
      return Promise.resolve(new Response(null, { status: 304, headers: { etag: '"v2"' } }));
    });
    await inspect(transport, { cache, cachePartition: "public" });
    const failure = await failureOf(inspect(transport, { cache, cachePartition: "public" }));
    expect(failure.code).toBe("http_error");
  });

  it("accepts a bare 304 and reports the entry as revalidated", async () => {
    const cache = createInMemoryOdpCache();
    let calls = 0;
    const transport: OdpTransport = vi.fn(() => {
      calls += 1;
      if (calls === 1)
        return Promise.resolve(
          odpResponse(document, { "cache-control": "max-age=0", etag: '"v1"' })
        );
      return Promise.resolve(new Response(null, { status: 304 }));
    });
    await inspect(transport, { cache, cachePartition: "public" });
    const revalidated = await inspect(transport, { cache, cachePartition: "public" });
    expect(revalidated.freshness).toBe("revalidated");
  });

  it("re-fetches when the cached representation no longer validates", async () => {
    const backing = createInMemoryOdpCache();
    let calls = 0;
    const transport: OdpTransport = vi.fn(() => {
      calls += 1;
      return Promise.resolve(odpResponse(document, { "cache-control": "max-age=60" }));
    });
    const corrupting: OdpCache = {
      delete: (resourceClass, key) => backing.delete(resourceClass, key),
      get: (resourceClass, key) => backing.get(resourceClass, key),
      set: (record) => backing.set({ ...record, value: { odp_version: "1.0" } })
    };
    await inspect(transport, { cache: corrupting, cachePartition: "public" });
    await inspect(transport, { cache: corrupting, cachePartition: "public" });
    expect(calls).toBe(2);
  });

  it("gives each joined caller its own copy of the inspection", async () => {
    const cache = createInMemoryOdpCache();
    const transport: OdpTransport = vi.fn(() => Promise.resolve(odpResponse(document)));
    const [first, second] = await Promise.all([
      inspect(transport, { cache, cachePartition: "public" }),
      inspect(transport, { cache, cachePartition: "public" })
    ]);
    expect(transport).toHaveBeenCalledTimes(1);
    // `capabilities` holds live arrays; sharing one object let a caller mutate another's view.
    expect(first.capabilities.operations).not.toBe(second.capabilities.operations);
    first.capabilities.operations.length = 0;
    expect(second.capabilities.operations).toHaveLength(2);
  });

  it("does not share an in-flight inspection between different transports", async () => {
    const cache = createInMemoryOdpCache();
    const first: OdpTransport = vi.fn(() => Promise.resolve(odpResponse(document)));
    const second: OdpTransport = vi.fn(() => Promise.resolve(odpResponse(document)));
    await Promise.all([
      inspect(first, { cache, cachePartition: "public" }),
      inspect(second, { cache, cachePartition: "public" })
    ]);
    // A caller-supplied transport carries its own credentials and destination policy, so two of
    // them must never resolve to one shared result.
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });
});

describe("Service Document failures", () => {
  it("reports a destination-policy rejection distinctly and keeps its cause", async () => {
    const transport: OdpTransport = vi.fn(() =>
      Promise.reject(
        new DestinationPolicyError("ODP request host resolved to a non-public address")
      )
    );
    const failure = await failureOf(inspect(transport));
    expect(failure.code).toBe("blocked_destination");
    expect(failure.message).toContain("non-public address");
    expect(failure.cause).toBeInstanceOf(TypeError);
  });

  it("recognizes a destination rejection wrapped by fetch", async () => {
    const cause = new DestinationPolicyError("ODP request connected to an unvalidated host");
    const error = new TypeError("fetch failed", { cause });
    const failure = await failureOf(inspect(() => Promise.reject(error)));
    expect(failure.code).toBe("blocked_destination");
    expect(failure.message).toContain(cause.message);
    expect(failure.cause).toBe(error);
  });

  it.each([
    new TypeError("fetch failed", { cause: new Error("connect ETIMEDOUT") }),
    new TypeError("fetch failed", { cause: new AggregateError([new Error("ECONNREFUSED")]) }),
    new TypeError("custom transport failure"),
    new RangeError("custom transport limit"),
    "connection lost"
  ])("does not infer destination policy from a generic transport failure: %s", async (error) => {
    const failure = await failureOf(inspect(vi.fn<OdpTransport>().mockRejectedValue(error)));
    expect(failure.code).toBe("http_error");
    expect(failure.status).toBeUndefined();
    expect(failure.cause).toBe(error);
  });

  it("preserves explicit errors from a custom transport", async () => {
    const error = new OdpInspectionError("Custom destination policy", "blocked_destination");
    expect(await failureOf(inspect(() => Promise.reject(error)))).toBe(error);
  });

  it("reports an abort as an abort and preserves its cause", async () => {
    const transport: OdpTransport = vi.fn(() =>
      Promise.reject(new DOMException("The operation was aborted", "AbortError"))
    );
    const failure = await failureOf(inspect(transport));
    expect(failure.code).toBe("aborted");
    expect(failure.cause).toBeInstanceOf(DOMException);
  });

  it("reports an aborted signal even when the transport rejected with something else", async () => {
    const controller = new AbortController();
    controller.abort();
    const transport: OdpTransport = vi.fn(() => Promise.reject(new TypeError("fetch failed")));
    const failure = await failureOf(inspect(transport, { signal: controller.signal }));
    expect(failure.code).toBe("aborted");
    expect(failure.cause).toBeInstanceOf(Error);
  });

  it("keeps the cause of an ordinary connection failure", async () => {
    const transport: OdpTransport = vi.fn(() => Promise.reject(new Error("connection reset")));
    const failure = await failureOf(inspect(transport));
    expect(failure.code).toBe("http_error");
    expect((failure.cause as Error).message).toBe("connection reset");
  });

  it("rejects a redirect that omits its Location", async () => {
    const transport: OdpTransport = vi.fn(() =>
      Promise.resolve(new Response(null, { status: 301 }))
    );
    const failure = await failureOf(inspect(transport));
    expect(failure.code).toBe("invalid_redirect");
    expect(failure.message).toContain("omitted Location");
  });

  it("rejects a redirect chain when maxRedirects is zero", async () => {
    const transport: OdpTransport = vi.fn(() =>
      Promise.resolve(new Response(null, { status: 302, headers: { location: "/elsewhere" } }))
    );
    const failure = await failureOf(inspect(transport, { maxRedirects: 0 }));
    expect(failure.code).toBe("invalid_redirect");
  });

  it("refuses a maxRedirects outside the permitted range", async () => {
    const transport: OdpTransport = vi.fn(() => Promise.resolve(odpResponse(document)));
    await expect(inspect(transport, { maxRedirects: 6 })).rejects.toThrow("maxRedirects");
  });

  it("rejects a Service Document nested past its depth limit", async () => {
    let value: unknown = { leaf: 1 };
    for (let index = 0; index < 9; index += 1) value = { child: value };
    const transport: OdpTransport = vi.fn(() =>
      Promise.resolve(odpResponse({ ...document, branding: value }))
    );
    const failure = await failureOf(inspect(transport));
    expect(failure.code).toBe("validation_failed");
  });

  it("accepts a nested but valid Service Document", async () => {
    // Counting a scalar leaf as its own level made the effective limit seven containers rather
    // than the eight the protocol allows.
    const transport: OdpTransport = vi.fn(() =>
      Promise.resolve(
        odpResponse({
          ...document,
          operations: [
            ...document.operations,
            { authentication: "not-required", name: "search-offerings" }
          ],
          keywords: ["compute"],
          branding: { icon: { src: "/icon.png" }, logo: { src: "/logo.png" } },
          search_capabilities: { filters: { linked: { href: "/odp/filters" } } }
        })
      )
    );
    const inspected = await inspect(transport);
    expect(inspected.document.branding?.icon.src).toBe("/icon.png");
    expect(inspected.freshness).toBe("fetched");
  });

  it("rejects a Service Document that streams past its byte limit", async () => {
    const oversized = JSON.stringify({ ...document, description: "x".repeat(70_000) });
    const transport: OdpTransport = vi.fn(() =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              const bytes = new TextEncoder().encode(oversized);
              // Chunked, and with no content-length, so only the streaming counter can catch it.
              for (let at = 0; at < bytes.length; at += 8_192)
                controller.enqueue(bytes.slice(at, at + 8_192));
              controller.close();
            }
          }),
          { headers: { "content-type": "application/odp+json" } }
        )
      )
    );
    const failure = await failureOf(inspect(transport));
    expect(failure.code).toBe("response_too_large");
  });

  it("discards a cache record whose stored policy cannot be restored", async () => {
    const backing = createInMemoryOdpCache();
    let calls = 0;
    const transport: OdpTransport = vi.fn(() => {
      calls += 1;
      return Promise.resolve(odpResponse(document, { "cache-control": "max-age=60" }));
    });
    await inspect(transport, { cache: backing, cachePartition: "public" });
    const corrupt: OdpCache = {
      delete: (resourceClass, key) => backing.delete(resourceClass, key),
      get: async (resourceClass, key) => {
        const record = await backing.get(resourceClass, key);
        return record === undefined ? undefined : { ...record, policy: { bad: true } as never };
      },
      set: (record) => backing.set(record)
    };
    await inspect(transport, { cache: corrupt, cachePartition: "public" });
    expect(calls).toBe(2);
  });

  it("requires a fetch implementation", async () => {
    await expect(
      inspectService({
        serviceUrl: "https://example.com",
        fetch: undefined as unknown as OdpTransport,
        allowLocalNetwork: false
      })
    ).rejects.toThrow();
  });
});

/** The single record the in-memory cache is holding for the Service Document. */
async function findRecord(cache: OdpCache): Promise<OdpCacheRecord> {
  const key = ["public", "https://example.com/.well-known/odp", ""].join("\u0000");
  const record = await cache.get("service-document", key);
  if (record === undefined) throw new Error("no cached Service Document");
  return record;
}
