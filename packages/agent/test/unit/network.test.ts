import { createServer } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { createDefaultTransport } from "../../src/network.js";

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
});
