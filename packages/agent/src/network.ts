import { lookup } from "node:dns/promises";
import type { LookupFunction } from "node:net";

import ipaddr from "ipaddr.js";
import { Agent, fetch as undiciFetch } from "undici";

import type { OdpTransport } from "./transport.js";

/**
 * Largest decoded body the default transport will buffer. ODP's largest single-document limit is
 * the OpenAPI Action document and the complete Attribute Schema reference graph, both 1,048,576
 * bytes. Per-resource limits are enforced by the caller; this bound exists so that a compressed
 * response cannot expand past any ODP limit (SEC-29: "Compression does not increase a limit").
 */
const MAX_DECODED_BYTES = 1_048_576;

/** Statuses that RFC 9110 defines as carrying no content, which `Response` refuses to pair with a body. */
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

/** @internal */
export class DestinationPolicyError extends TypeError {}

export function createDefaultTransport(allowLocalNetwork = false): OdpTransport {
  return async (input, init) => {
    const url = new URL(String(input));
    if (url.username !== "" || url.password !== "")
      throw new DestinationPolicyError("ODP request URL must not contain credentials");
    const hostname = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
    const local = isLocalDevelopmentHost(hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && local && allowLocalNetwork))
      throw new DestinationPolicyError(
        "ODP requests require HTTPS unless local development is enabled"
      );
    const records = await resolvePublicAddresses(hostname, local && allowLocalNetwork);
    const address = records[0];
    if (address === undefined) throw new TypeError("ODP request host did not resolve");
    if (init?.body !== undefined && init.body !== null && typeof init.body !== "string")
      throw new TypeError("ODP default transport accepts string request bodies");
    const pinnedLookup: LookupFunction = (requestedHost, options, callback) => {
      // The dispatcher is single-use and pinned to one validated host. Refuse any other name so a
      // redirect or connection reuse cannot borrow the validated addresses (SEC-10, SEC-11).
      const requested = requestedHost.startsWith("[") ? requestedHost.slice(1, -1) : requestedHost;
      if (requested !== hostname) {
        callback(new DestinationPolicyError("ODP request connected to an unvalidated host"), "", 0);
        return;
      }
      if (options.all === true) {
        callback(null, records);
        return;
      }
      callback(null, address.address, address.family);
    };
    const dispatcher = new Agent({
      connect: { lookup: pinnedLookup },
      maxResponseSize: MAX_DECODED_BYTES
    });
    try {
      const received = await undiciFetch(url, {
        dispatcher,
        // Redirects are followed by the ODP layer so that every hop is re-resolved and re-validated
        // against destination policy, and so the origin lock is applied (SEC-11, SEC-16, ERR-24).
        redirect: "manual",
        ...(init?.body === undefined || init.body === null ? {} : { body: init.body }),
        ...(init?.headers === undefined
          ? {}
          : { headers: Object.fromEntries(new Headers(init.headers).entries()) }),
        ...(init?.method === undefined ? {} : { method: init.method }),
        ...(init?.signal === undefined || init.signal === null ? {} : { signal: init.signal })
      });
      const headers = new Headers();
      received.headers.forEach((value, name) => headers.append(name, value));
      // `maxResponseSize` bounds wire bytes, which content-coding can expand without limit. Read the
      // decoded body under an explicit budget instead of buffering whatever it decompresses to.
      const body = NULL_BODY_STATUSES.has(received.status)
        ? null
        : await readBounded(received.body, MAX_DECODED_BYTES);
      return new Response(body, {
        headers,
        status: received.status,
        statusText: received.statusText
      });
    } finally {
      // `catch` inside the `finally` so a close failure can never replace the original rejection.
      await dispatcher.close().catch(() => undefined);
    }
  };
}

async function resolvePublicAddresses(
  hostname: string,
  localDevelopment: boolean
): Promise<{ address: string; family: number }[]> {
  const records = await lookup(hostname, { all: true, verbatim: true });
  if (records.length === 0) throw new TypeError("ODP request host did not resolve");
  for (const record of records) {
    const range = ipaddr.process(record.address).range();
    if (localDevelopment) {
      if (range !== "loopback")
        throw new DestinationPolicyError(
          "ODP local-development host resolved outside the loopback network"
        );
    } else if (range !== "unicast") {
      // Rejects the whole target rather than selecting a passing record (SEC-09).
      throw new DestinationPolicyError("ODP request host resolved to a non-public address");
    }
  }
  return records;
}

/**
 * Structural view of the response body. undici types its stream as `ReadableStream<any>`, which is
 * not assignable to the global `ReadableStream<Uint8Array>`; matching on shape keeps this typed
 * without casting through `any`.
 */
interface ByteStream {
  getReader(): {
    read(): Promise<{ done: boolean; value?: Uint8Array | undefined }>;
    cancel(): Promise<void>;
    releaseLock(): void;
  };
}

async function readBounded(stream: ByteStream | null, maximum: number): Promise<ArrayBuffer> {
  if (stream === null) return new ArrayBuffer(0);
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      const chunk = part.value;
      if (chunk === undefined) continue;
      length += chunk.byteLength;
      if (length > maximum) {
        await reader.cancel();
        throw new RangeError("ODP response exceeds its decoded byte limit");
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  const buffer = new ArrayBuffer(length);
  const bytes = new Uint8Array(buffer);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return buffer;
}

function isLocalDevelopmentHost(hostname: string): boolean {
  return hostname.toLowerCase() === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}
