import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { gzipSync } from "node:zlib";

import { afterEach, describe, expect, it } from "vitest";

import { createDefaultTransport } from "../../src/network.js";
import { inspectService } from "../../src/inspection.js";

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error)))
    );
  }
});

describe("default ODP transport", () => {
  it("classifies an actual fetch socket failure as a connection error", async () => {
    const server = createServer((request) => request.socket.destroy());
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("server has no TCP port");
    await expect(
      inspectService({
        serviceUrl: `http://127.0.0.1:${address.port}`,
        allowLocalNetwork: true
      })
    ).rejects.toMatchObject({ code: "http_error", cause: { name: "TypeError" } });
  });

  it("classifies an actual private destination rejection without making a request", async () => {
    const failure = inspectService({ serviceUrl: "https://127.0.0.1" });
    await expect(failure).rejects.toMatchObject({ code: "blocked_destination" });
    await expect(failure).rejects.toThrow("non-public address");
  });

  it("rejects non-public destinations", async () => {
    await expect(createDefaultTransport()(new URL("https://127.0.0.1/"))).rejects.toThrow(
      "non-public address"
    );
  });

  it("allows explicit loopback development", async () => {
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "application/odp+json");
      response.end("{}");
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("server has no TCP port");
    const response = await createDefaultTransport(true)(
      new URL(`http://127.0.0.1:${address.port}/`)
    );
    expect(response.status).toBe(200);
  });

  it("supports hostname connections that request all resolved addresses", async () => {
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "application/odp+json");
      response.end("{}");
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("server has no TCP port");
    const response = await createDefaultTransport(true)(
      new URL(`http://localhost:${address.port}/`)
    );
    expect(response.status).toBe(200);
  });
  it("returns a 304 instead of failing to construct the response", async () => {
    // `new Response(body, { status: 304 })` throws, so building every reply with a body made the
    // transport reject on any conditional request and disabled revalidation entirely.
    const url = await serve((_request, response) => {
      response.statusCode = 304;
      response.setHeader("etag", '"v1"');
      response.end();
    });
    const received = await createDefaultTransport(true)(url);
    expect(received.status).toBe(304);
    expect(received.headers.get("etag")).toBe('"v1"');
  });

  it("passes a 204 through without a body", async () => {
    const url = await serve((_request, response) => {
      response.statusCode = 204;
      response.end();
    });
    const received = await createDefaultTransport(true)(url);
    expect(received.status).toBe(204);
  });

  it("refuses a compressed body that decodes past the transport budget", async () => {
    const payload = gzipSync(Buffer.alloc(2 * 1_048_576, 0x61));
    const url = await serve((_request, response) => {
      response.setHeader("content-type", "application/odp+json");
      response.setHeader("content-encoding", "gzip");
      response.end(payload);
    });
    // The wire body is a few kilobytes, so a wire-byte cap alone would have let it through and
    // buffered the whole decompressed result.
    expect(payload.byteLength).toBeLessThan(64_000);
    await expect(createDefaultTransport(true)(url)).rejects.toThrow("decoded byte limit");
  });

  it("accepts a compressed body that stays within the budget", async () => {
    const payload = gzipSync(Buffer.from(JSON.stringify({ padding: "a".repeat(200_000) })));
    const url = await serve((_request, response) => {
      response.setHeader("content-type", "application/odp+json");
      response.setHeader("content-encoding", "gzip");
      response.end(payload);
    });
    const received = await createDefaultTransport(true)(url);
    expect(received.status).toBe(200);
    expect((await received.text()).length).toBeGreaterThan(200_000);
  });

  it("does not follow redirects itself, so every hop can be revalidated", async () => {
    let hits = 0;
    const url = await serve((request, response) => {
      hits += 1;
      if (request.url === "/moved") {
        response.setHeader("content-type", "application/odp+json");
        response.end("{}");
        return;
      }
      response.statusCode = 302;
      response.setHeader("location", "/moved");
      response.end();
    });
    const received = await createDefaultTransport(true)(url);
    expect(received.status).toBe(302);
    expect(received.headers.get("location")).toBe("/moved");
    expect(hits).toBe(1);
  });

  it("refuses a URL that carries credentials", async () => {
    await expect(
      createDefaultTransport(true)(new URL("https://user:secret@example.com/"))
    ).rejects.toThrow("must not contain credentials");
  });

  it("refuses plain HTTP unless local development is enabled", async () => {
    await expect(createDefaultTransport()(new URL("http://example.com/"))).rejects.toThrow(
      "require HTTPS"
    );
    await expect(createDefaultTransport()(new URL("http://localhost/"))).rejects.toThrow(
      "require HTTPS"
    );
  });

  it("refuses a request body that is not a string", async () => {
    const url = await serve((_request, response) => {
      response.end("{}");
    });
    await expect(
      createDefaultTransport(true)(url, { method: "POST", body: new Blob(["{}"]) })
    ).rejects.toThrow("string request bodies");
  });

  it("sends the caller's method, headers and body", async () => {
    let seen: { method?: string; header?: string; body: string } | undefined;
    const url = await serve((request, response) => {
      let body = "";
      request.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
      request.on("end", () => {
        seen = {
          ...(request.method === undefined ? {} : { method: request.method }),
          ...(typeof request.headers["x-test"] === "string"
            ? { header: request.headers["x-test"] }
            : {}),
          body
        };
        response.setHeader("content-type", "application/odp+json");
        response.end("{}");
      });
    });
    await createDefaultTransport(true)(url, {
      method: "POST",
      headers: { "x-test": "yes" },
      body: '{"a":1}'
    });
    expect(seen).toEqual({ method: "POST", header: "yes", body: '{"a":1}' });
  });

  it("honours an abort signal", async () => {
    const url = await serve(() => {
      // Never responds, so only the signal can end the request.
    });
    const controller = new AbortController();
    const pending = createDefaultTransport(true)(url, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow();
  });

  it("reaches a loopback host over IPv6", async () => {
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "application/odp+json");
      response.end("{}");
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "::1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("server has no TCP port");
    const received = await createDefaultTransport(true)(
      new URL(`http://[::1]:${String(address.port)}/`)
    );
    expect(received.status).toBe(200);
  });

  it("rejects a host that does not resolve", async () => {
    await expect(
      createDefaultTransport()(new URL("https://nonexistent.invalid/"))
    ).rejects.toThrow();
  });
});

/** Starts a loopback HTTP server for the duration of the test and returns its base URL. */
async function serve(
  handler: (request: IncomingMessage, response: ServerResponse) => void
): Promise<URL> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("server has no TCP port");
  return new URL(`http://127.0.0.1:${String(address.port)}/`);
}
