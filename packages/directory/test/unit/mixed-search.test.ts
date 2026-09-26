import { describe, expect, it, vi } from "vitest";

import { createDirectoryClient, type DirectoryResourceSearchRequest } from "../../src/index.js";

const indexedAt = "2026-09-18T12:00:00Z";
const service = {
  source: { type: "odp", url: "https://api.example.com/.well-known/odp", x402_discovery: false },
  service_id: "ca0304cc-ab28-43e5-af94-7bdf11b40c6e",
  service_origin: "https://api.example.com",
  name: "Example Service",
  description: "Data services.",
  language: "en",
  localizations: ["en"],
  indexed_at: "2026-09-18T11:00:00Z",
  operations: [
    { name: "get-collection", authentication: "not-required" },
    { name: "list-offerings", authentication: "not-required" },
    { name: "get-offering", authentication: "not-required" }
  ]
};
const collection = {
  type: "collection",
  indexed_at: indexedAt,
  service,
  collection: {
    id: "Weather",
    name: "Weather forecasts",
    description: "Forecasts and current conditions."
  }
};
const serviceResult = { type: "service", indexed_at: service.indexed_at, service };
const attribution = {
  publisher_id: "platform",
  website_url: "https://platform.example/catalog",
  name: "Platform"
};

function json(value: unknown): Response {
  return Response.json(value);
}

function inputUrl(input: string | Request | URL | undefined): string {
  return input instanceof Request ? input.url : String(input);
}

function bodyOf(init: RequestInit | undefined): unknown {
  return JSON.parse(typeof init?.body === "string" ? init.body : "null");
}

async function collect<T>(values: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const value of values) result.push(value);
  return result;
}

describe("mixed Directory discovery", () => {
  it("reads the server envelope and preserves result identity, freshness and attribution", async () => {
    const unknown = { type: "offering", arbitrary: { id: "future" } };
    const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(
      json({
        items: [{ ...serviceResult, publisher: attribution }, collection, unknown],
        facets: { keywords: [{ value: "weather", count: 12 }] },
        extra: true
      })
    );
    const client = createDirectoryClient({ transport });
    const pages = await collect(
      client.search({ query: "weather", types: ["service", "collection"], limit: 25 }).pages
    );
    expect(pages).toEqual([
      {
        items: [
          { ...serviceResult, publisher: attribution },
          collection,
          { type: "unknown", resource_type: "offering", raw: unknown }
        ],
        facets: { keywords: [{ value: "weather", count: 12 }] },
        extra: true
      }
    ]);
    const [url, init] = transport.mock.calls[0] ?? [];
    expect(inputUrl(url)).toBe("https://api.inflowpay.ai/v1/directory/search");
    expect(init?.method).toBe("POST");
    expect(bodyOf(init)).toEqual({
      query: "weather",
      types: ["service", "collection"],
      limit: 25
    });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("copies request inputs before lazy execution and keeps Service-only routes", async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockImplementation(() => Promise.resolve(json({ items: [] })));
    const client = createDirectoryClient({ environment: "sandbox", transport });
    const request: DirectoryResourceSearchRequest = {
      types: ["collection"],
      filters: { keywords: ["weather"] }
    };
    const sequence = client.search(request);
    request.types?.splice(0);
    request.filters?.keywords?.splice(0);
    await collect(sequence.items);
    expect(bodyOf(transport.mock.calls[0]?.[1])).toEqual({
      types: ["collection"],
      filters: { keywords: ["weather"] }
    });
    await collect(client.searchServices().items);
    expect(inputUrl(transport.mock.calls[1]?.[0])).toBe(
      "https://sandbox.inflowpay.ai/v1/services/search"
    );
    await collect(client.search().items);
    expect(bodyOf(transport.mock.calls[2]?.[1])).toEqual({});
  });

  it("uses independent lazy traversals and respects both iteration limits", async () => {
    const transport = vi.fn<typeof fetch>().mockImplementation((input) =>
      Promise.resolve(
        json({
          items: [collection, serviceResult],
          ...(inputUrl(input).includes("cursor") ? {} : { next: "/v1/directory/search?cursor=2" })
        })
      )
    );
    const client = createDirectoryClient({ transport });
    const results = client.search({}, { maxPages: 1, maxItems: 1 });
    expect(transport).not.toHaveBeenCalled();
    expect(await collect(results.items)).toEqual([collection]);
    expect(await collect(results.pages)).toHaveLength(1);
    expect(transport).toHaveBeenCalledTimes(2);
    expect(
      await collect(
        client.continueSearch("/v1/directory/search?cursor=2", { maxItems: 1, maxPages: 1 }).items
      )
    ).toEqual([collection]);
    expect(transport.mock.calls[2]?.[1]?.method).toBe("GET");
    expect(transport.mock.calls[2]?.[1]?.body).toBeUndefined();
    expect(await collect(client.search().items)).toHaveLength(4);
  });

  it("preserves abort signals through mixed continuations and rejects unsafe continuation origins", async () => {
    const controller = new AbortController();
    const transport = vi.fn<typeof fetch>().mockImplementation((_input, init) => {
      expect(init?.signal).toBe(controller.signal);
      return Promise.resolve(json({ items: [], next: "/v1/directory/search?cursor=2" }));
    });
    const client = createDirectoryClient({ transport });
    await expect(collect(client.search({}, { signal: controller.signal }).pages)).rejects.toThrow(
      "pagination loop"
    );
    transport.mockClear();
    await expect(
      collect(client.continueSearch("https://elsewhere.example/search").pages)
    ).rejects.toThrow("canonical origin");
    expect(transport).not.toHaveBeenCalled();
    await expect(
      collect(client.continueSearch("/v1/directory/search", { signal: controller.signal }).items)
    ).rejects.toThrow("pagination loop");
  });

  it("reports invalid known items without dropping valid or unknown items", async () => {
    const malformed = [
      null,
      {},
      { type: "" },
      { ...collection, service: null },
      { ...collection, service: { ...service, service_id: "" } },
      { ...collection, indexed_at: "not-a-date" },
      { ...collection, indexed_at: "2026-99-99T00:00:00Z" },
      { ...collection, collection: null },
      { ...collection, collection: { ...collection.collection, id: "../escape" } },
      { ...collection, collection: { ...collection.collection, name: "" } },
      { ...collection, collection: { ...collection.collection, description: null } },
      { ...collection, collection: { ...collection.collection, description: "x".repeat(1025) } },
      {
        ...serviceResult,
        publisher: { ...attribution, website_url: "http://platform.example" }
      },
      {
        ...serviceResult,
        publisher: { ...attribution, website_url: "https://user:secret@platform.example/path" }
      },
      {
        ...serviceResult,
        publisher: { ...attribution, website_url: "not-a-url" }
      },
      { ...serviceResult, publisher: { ...attribution, publisher_id: "" } },
      { ...serviceResult, publisher: { ...attribution, name: "" } },
      { ...serviceResult, publisher: [] },
      {
        ...serviceResult,
        publisher: { ...attribution, website_url: "https://user@platform.example/" }
      }
    ];
    const client = createDirectoryClient({
      transport: () => Promise.resolve(json({ items: [...malformed, collection] }))
    });
    const [page] = await collect(client.search().pages);
    expect(page?.items).toEqual([collection]);
    expect(page?.issues?.map(({ index }) => index)).toEqual(malformed.map((_, index) => index));
  });

  it("accepts omitted optional metadata, empty descriptions and additive fields", async () => {
    const items = [
      serviceResult,
      { ...serviceResult, publisher: null },
      {
        ...serviceResult,
        available_through: { service_id: "legacy", service_origin: "https://legacy.example" }
      },
      { ...serviceResult, future_metadata: { arbitrary: true } },
      {
        ...serviceResult,
        publisher: { ...attribution, extra: { retained: true } }
      },
      { ...collection, collection: { id: "Weather", name: "Forecasts", extra: 1 } },
      { ...collection, collection: { ...collection.collection, description: "" } }
    ];
    const client = createDirectoryClient({ transport: () => Promise.resolve(json({ items })) });
    expect(await collect(client.search().items)).toEqual(items);
  });

  it("rejects invalid type filters and iteration options before transport", () => {
    const transport = vi.fn<typeof fetch>();
    const client = createDirectoryClient({ transport });
    for (const types of [
      [],
      ["offering"],
      ["service", "service"],
      ["service", "collection", "service"],
      null,
      "service"
    ]) {
      // Exercise untyped JavaScript callers at the public input boundary.
      expect(() => client.search({ types } as DirectoryResourceSearchRequest)).toThrow("types");
    }
    expect(() => client.search({ query: " " })).toThrow("query");
    expect(() => client.search({}, { maxPages: 0 })).toThrow("maxPages");
    expect(() => client.search({}, { maxItems: 0 })).toThrow("maxItems");
    expect(() => client.continueSearch(" ")).toThrow("next");
    expect(() => client.continueSearch("/next", { maxPages: 0 })).toThrow("maxPages");
    expect(() => client.continueSearch("/next", { maxItems: 0 })).toThrow("maxItems");
    expect(transport).not.toHaveBeenCalled();
  });

  it("returns matching names from mixed suggestions and keeps Service keyword suggestions separate", async () => {
    const signal = new AbortController().signal;
    const transport = vi
      .fn<typeof fetch>()
      .mockImplementation(() =>
        Promise.resolve(json({ items: ["AccuWeather", "Atlas", "Atlas"] }))
      );
    const client = createDirectoryClient({ transport });
    expect(await client.suggest({ prefix: "we", limit: 10, signal })).toEqual([
      "AccuWeather",
      "Atlas"
    ]);
    expect(inputUrl(transport.mock.calls[0]?.[0])).toBe(
      "https://api.inflowpay.ai/v1/directory/suggestions"
    );
    expect(transport.mock.calls[0]?.[1]?.method).toBe("POST");
    const body = transport.mock.calls[0]?.[1]?.body;
    expect(typeof body === "string" ? JSON.parse(body) : undefined).toEqual({
      prefix: "we",
      limit: 10
    });
    expect(transport.mock.calls[0]?.[1]?.signal).toBe(signal);
    await client.suggestServices({ prefix: "we" });
    expect(inputUrl(transport.mock.calls[1]?.[0])).toBe(
      "https://api.inflowpay.ai/v1/services/suggestions?prefix=we"
    );
    await expect(client.suggest({ prefix: " " })).rejects.toThrow("prefix");
    await expect(client.suggest({ prefix: "we", limit: 26 })).rejects.toThrow("limit");
  });

  it("validates and sends suggestion filters without changing the names response", async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(json({ items: ["Weather"] }));
    const client = createDirectoryClient({ transport });
    const filters = {
      enrollment: [{ name: "aep" as const }],
      keywords: ["weather"],
      operations: [{ name: "get-offering" as const }],
      payments: [{ name: "mpp" as const, options: ["inflow" as const] }],
      trust: [{ name: "tap" as const }]
    };
    expect(await client.suggest({ prefix: "we", filters })).toEqual(["Weather"]);
    const body = transport.mock.calls[0]?.[1]?.body;
    expect(typeof body === "string" ? JSON.parse(body) : undefined).toEqual({
      prefix: "we",
      filters
    });
    expect(new Headers(transport.mock.calls[0]?.[1]?.headers).get("content-type")).toBe(
      "application/json"
    );
    await expect(client.suggest({ prefix: "we", filters: { keywords: [] } })).rejects.toThrow();
    await expect(client.suggestServices({ prefix: "we", filters })).rejects.toThrow(
      "do not support filters"
    );
    expect(transport).toHaveBeenCalledTimes(1);
  });
});
