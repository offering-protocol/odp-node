import { describe, expect, it, vi } from "vitest";

import { resolveOpenApiOperation } from "../../src/openapi.js";
import type { OdpTransport } from "../../src/transport.js";

const OPERATION = {
  operationId: "buy",
  responses: { "200": { description: "ok" } }
};

function documentFor(extra: Record<string, unknown>): Record<string, unknown> {
  return { openapi: "3.1.0", info: { title: "Example", version: "1.0.0" }, ...extra };
}

function transportFor(document: unknown, type = "application/json"): OdpTransport {
  return vi.fn(() =>
    Promise.resolve(new Response(JSON.stringify(document), { headers: { "content-type": type } }))
  );
}

function resolve(document: unknown, operationId = "buy"): Promise<unknown> {
  return resolveOpenApiOperation({
    url: new URL("https://example.com/openapi.json"),
    operationId,
    transport: transportFor(document)
  });
}

describe("OpenAPI Action resolution", () => {
  it("preserves spaced security-scheme names, references, and requirements", async () => {
    const document = documentFor({
      paths: {
        "/buy": { post: { ...OPERATION, security: [{ "API Key or OAuth": [] }] } }
      },
      components: {
        securitySchemes: {
          "API Key or OAuth": { type: "apiKey", in: "header", name: "X-Api-Key" },
          alias: { $ref: "#/components/securitySchemes/API%20Key%20or%20OAuth" }
        }
      }
    });
    const before = structuredClone(document);
    const resolved = await resolveOpenApiOperation({
      url: new URL("https://example.com/openapi.json"),
      operationId: "buy",
      transport: transportFor(document)
    });
    expect(resolved.document).toEqual(before);
    expect(resolved.operation["security"]).toEqual([{ "API Key or OAuth": [] }]);
    expect(document).toEqual(before);
  });

  it.each(["API/Key", "API\tKey", "API\nKey", "API%20Key", "API@Key", ""])(
    "rejects other invalid security-scheme names: %j",
    async (name) => {
      await expect(
        resolve(
          documentFor({
            paths: { "/buy": { post: OPERATION } },
            components: { securitySchemes: { [name]: { type: "http", scheme: "bearer" } } }
          })
        )
      ).rejects.toThrow("OpenAPI document is invalid");
    }
  );

  it.each([
    { info: { title: 7, version: "1" } },
    { paths: { "/buy": { post: { operationId: 7 } } } },
    { components: { securitySchemes: { "API Key": { type: "invalid" } } } },
    {
      components: {
        schemas: { "Invalid Name": { type: "string" } },
        securitySchemes: { "API Key": { type: "http", scheme: "bearer" } }
      }
    }
  ])("does not suppress other validation failures alongside a spaced name", async (extra) => {
    await expect(
      resolve(
        documentFor({
          paths: { "/buy": { post: OPERATION } },
          components: { securitySchemes: { "API Key": { type: "http", scheme: "bearer" } } },
          ...extra
        })
      )
    ).rejects.toThrow("OpenAPI document is invalid");
  });

  it("resolves an operation declared under paths", async () => {
    const resolved = await resolveOpenApiOperation({
      url: new URL("https://example.com/openapi.json"),
      operationId: "buy",
      transport: transportFor(documentFor({ paths: { "/buy": { post: OPERATION } } }))
    });
    expect(resolved.operation["operationId"]).toBe("buy");
    expect(resolved.document["openapi"]).toBe("3.1.0");
  });

  it("resolves an operation declared under webhooks", async () => {
    // OpenAPI 3.1 makes `paths` optional and allows Operation Objects under `webhooks`; requiring
    // `paths` used to make such a document unusable.
    const resolved = await resolveOpenApiOperation({
      url: new URL("https://example.com/openapi.json"),
      operationId: "buy",
      transport: transportFor(documentFor({ webhooks: { order: { post: OPERATION } } }))
    });
    expect(resolved.operation["operationId"]).toBe("buy");
  });

  it("resolves an operation declared under components.pathItems", async () => {
    const resolved = await resolveOpenApiOperation({
      url: new URL("https://example.com/openapi.json"),
      operationId: "buy",
      transport: transportFor(
        documentFor({ components: { pathItems: { shared: { get: OPERATION } } } })
      )
    });
    expect(resolved.operation["operationId"]).toBe("buy");
  });

  it("refuses an operation identifier that appears in two containers", async () => {
    // Searching only `paths` would have reported this ambiguous document as resolving exactly once.
    await expect(
      resolve(
        documentFor({
          paths: { "/buy": { post: OPERATION } },
          webhooks: { order: { post: OPERATION } }
        })
      )
    ).rejects.toThrow("must resolve exactly once");
  });

  it("refuses an identifier that appears twice under paths and one that appears not at all", async () => {
    await expect(
      resolve(documentFor({ paths: { "/a": { post: OPERATION }, "/b": { get: OPERATION } } }))
    ).rejects.toThrow("must resolve exactly once");
    await expect(
      resolve(documentFor({ paths: { "/buy": { post: OPERATION } } }), "missing")
    ).rejects.toThrow("must resolve exactly once");
  });

  it("requires an OpenAPI version in the 3.1 line", async () => {
    await expect(
      resolve({
        openapi: "3.0.3",
        info: { title: "Example", version: "1.0.0" },
        paths: { "/buy": { post: OPERATION } }
      })
    ).rejects.toThrow("OpenAPI 3.1 document");
    await expect(
      resolve({ info: { title: "Example", version: "1.0.0" }, paths: {} })
    ).rejects.toThrow("OpenAPI 3.1 document");
  });

  it("rejects a document that is not a JSON object or fails schema validation", async () => {
    await expect(resolve([])).rejects.toThrow("must be a JSON object");
    await expect(
      resolve(documentFor({ paths: { "/buy": { post: { operationId: 7 } } } }))
    ).rejects.toThrow();
  });

  it("skips path items and methods that are not objects", async () => {
    const resolved = await resolveOpenApiOperation({
      url: new URL("https://example.com/openapi.json"),
      operationId: "buy",
      transport: transportFor(
        documentFor({
          paths: {
            "/skip": { summary: "not an operation" },
            "/buy": { post: OPERATION }
          }
        })
      )
    });
    expect(resolved.operation["operationId"]).toBe("buy");
  });

  it("accepts the OpenAPI media type as well as plain JSON", async () => {
    const resolved = await resolveOpenApiOperation({
      url: new URL("https://example.com/openapi.json"),
      operationId: "buy",
      transport: transportFor(
        documentFor({ paths: { "/buy": { post: OPERATION } } }),
        "application/vnd.oai.openapi+json;version=3.1"
      )
    });
    expect(resolved.operation["operationId"]).toBe("buy");
  });

  it("rejects a document served under an unrelated media type", async () => {
    await expect(
      resolveOpenApiOperation({
        url: new URL("https://example.com/openapi.json"),
        operationId: "buy",
        transport: transportFor(
          documentFor({ paths: { "/buy": { post: OPERATION } } }),
          "text/plain"
        )
      })
    ).rejects.toThrow("media type is invalid");
  });

  it("returns copies rather than references into the retrieved document", async () => {
    const document = documentFor({ paths: { "/buy": { post: { ...OPERATION } } } });
    const resolved = await resolveOpenApiOperation({
      url: new URL("https://example.com/openapi.json"),
      operationId: "buy",
      transport: transportFor(document)
    });
    resolved.operation["operationId"] = "mutated";
    expect(document["paths"]).toBeDefined();
    const paths = document["paths"] as Record<string, Record<string, { operationId: string }>>;
    expect(paths["/buy"]?.["post"]?.operationId).toBe("buy");
  });
});
