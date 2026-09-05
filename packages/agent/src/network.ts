import { lookup } from "node:dns/promises";
import type { LookupFunction } from "node:net";

import ipaddr from "ipaddr.js";
import { Agent, fetch as undiciFetch } from "undici";

import type { OdpTransport } from "./transport.js";

export function createDefaultTransport(allowLocalNetwork = false): OdpTransport {
  return async (input, init) => {
    const url = new URL(String(input));
    if (url.username !== "" || url.password !== "")
      throw new TypeError("ODP request URL must not contain credentials");
    const hostname = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
    const local = isLocalDevelopmentHost(hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && local && allowLocalNetwork))
      throw new TypeError("ODP requests require HTTPS unless local development is enabled");
    const records = await lookup(hostname, { all: true, verbatim: true });
    if (records.length === 0) throw new TypeError("ODP request host did not resolve");
    for (const record of records) {
      const range = ipaddr.process(record.address).range();
      if (local && allowLocalNetwork) {
        if (range !== "loopback")
          throw new TypeError("ODP local-development host resolved outside the loopback network");
      } else if (range !== "unicast") {
        throw new TypeError("ODP request host resolved to a non-public address");
      }
    }
    const address = records[0];
    if (address === undefined) throw new TypeError("ODP request host did not resolve");
    if (init?.body !== undefined && init.body !== null && typeof init.body !== "string")
      throw new TypeError("ODP default transport accepts string request bodies");
    const pinnedLookup: LookupFunction = (_hostname, options, callback) => {
      if (options.all === true) {
        callback(null, records);
        return;
      }
      callback(null, address.address, address.family);
    };
    const dispatcher = new Agent({
      connect: { lookup: pinnedLookup },
      maxResponseSize: 1_048_576
    });
    try {
      const received = await undiciFetch(url, {
        dispatcher,
        ...(init?.body === undefined || init.body === null ? {} : { body: init.body }),
        ...(init?.headers === undefined
          ? {}
          : { headers: Object.fromEntries(new Headers(init.headers).entries()) }),
        ...(init?.method === undefined ? {} : { method: init.method }),
        ...(init?.redirect === undefined ? {} : { redirect: init.redirect }),
        ...(init?.signal === undefined || init.signal === null ? {} : { signal: init.signal })
      });
      const body = await received.arrayBuffer();
      const headers = new Headers();
      received.headers.forEach((value, name) => headers.append(name, value));
      return new Response(body, {
        headers,
        status: received.status,
        statusText: received.statusText
      });
    } finally {
      await dispatcher.close();
    }
  };
}

function isLocalDevelopmentHost(hostname: string): boolean {
  return hostname.toLowerCase() === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}
