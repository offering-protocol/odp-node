# `@offering-protocol/directory`

The official client for discovering Services and indexed Collections in the canonical directory.

## Install

```sh
npm install @offering-protocol/directory
```

The package has two environments and no configurable base URL:

- `createDirectoryClient()` uses `https://api.inflowpay.ai`.
- `createDirectoryClient({ environment: "sandbox" })` uses
  `https://sandbox.inflowpay.ai`.

A fetch-compatible `transport` can be injected for testing without changing the selected origin.

## Cloudflare Workers

The Directory client uses the runtime's `fetch` API. Call it from a Worker request handler, where
outbound requests are allowed, and use the Node compatibility settings from the
[Workers example](../../examples/odp-service-cloudflare/README.md#use-it-in-your-worker).

Directory search does not resolve Offering Attribute Schemas. Navigating a Service through the
Agent package has [additional Workers limitations](../agent/README.md#cloudflare-workers).

## Search the Directory

`search()` returns native ODP Services, imported OpenAPI Services, and indexed Collections. It searches cached names,
descriptions, and Service keywords; it does not crawl catalogs or search individual Offerings.
Omit `types` to include both result types, or pass `["service"]` or `["collection"]`.

```ts
import { createDirectoryClient } from "@offering-protocol/directory";

const directory = createDirectoryClient();
for await (const result of directory.search({ query: "weather", limit: 25 }).items) {
  if (result.type !== "unknown" && result.service.source.type !== "odp") {
    showDiscoveryDocument(result.service.source);
    continue;
  }
  switch (result.type) {
    case "service":
      useService(result.service.service_origin);
      break;
    case "collection":
      useCollection(result.service.service_origin, result.collection.id);
      break;
    case "unknown":
      reportUnsupportedType(result.resource_type, result.raw);
      break;
  }
}
```

The example's `showDiscoveryDocument`, `useService`, `useCollection`, and `reportUnsupportedType`
functions represent your application's handling of a result. Preserve `service_id` and the Collection
ID together: multiple imported Services can share an API origin but use different source documents.
For an ODP result, inspect the Service's live ODP document before fetching Collection details through
`createOdpServiceClient` from `@offering-protocol/agent`.

Every known result includes `service.source`:

```json
{
  "type": "openapi",
  "url": "https://docs.example.com/v1/openapi.json?revision=2",
  "x402_discovery": true
}
```

`type` identifies the discovery format. `url` preserves the exact primary document URL, including
its path and query; it can be hosted on a different origin than `service_origin`. `x402_discovery`
indicates detected supporting `/.well-known/x402.json` metadata, not proof that an endpoint accepts
x402. These fields are required; the client does not infer ODP when `source` is missing.

For OpenAPI and unfamiliar source types, description, language, localizations, and keywords can be
absent. The client does not manufacture these values or expose ODP `operations` on imported results.
Unknown source types remain displayable; do not send them to an ODP Agent client. This package does
not download or execute OpenAPI documents. An imported Collection is a Directory presentation group:
use its parent's `source.url` for discovery, not ODP `getCollection(collection.id)`.

Use `filters: { sources: ["odp"] }` for native ODP results or `["openapi"]` for imports. Omit `sources`
for all sources, or specify both. An empty list, duplicates, and unsupported filter values are rejected.

Each known result carries `service` metadata and `indexed_at`. For a Collection, the outer timestamp
describes its indexed metadata; `service.indexed_at` describes its parent. A Service result can have
`publisher`, display attribution with `publisher_id`, `name`, and `website_url`.
The website is a human-facing link, not a discovery document or execution target.
Publisher attribution is optional; additional response fields are preserved.
This describes availability, not brand ownership. A Collection's owning `service` provides its
attribution.

Mixed filters use the same `filters` structure shown below and apply to the owning Service.
Whitespace-separated query terms are alternatives, matched as case-insensitive substrings.
Facets count all matching targets: a Service and two matching Collections count as three, even if
the response limit excludes some of them.

`items` and `pages` are independent lazy traversals beginning with `POST /v1/directory/search`.
The server returns at most 100 items (also its default) and currently provides no continuation.
**An absent `next` does not mean every matching target was returned.** Narrow the query or filters
when necessary. The client supports optional same-origin continuation links when supplied, and
`continueSearch(next)` resumes one with GET. It does not invent cursors or additional requests.
`maxItems`, `maxPages`, and `signal` work as with Service-only search.

Known result types are validated; malformed entries appear in the page's `issues` with their
original indexes and are omitted from `items`. An unfamiliar type is instead preserved as
`{ type: "unknown", resource_type, raw }`. Do not treat its unvalidated `raw` content as a Service
or automatically follow URLs inside it. Additional fields on known results are tolerated. Nested
Service metadata uses strict ODP validation when `source.type` is `odp`. Imported metadata is checked
for its declared JSON types without requiring an ODP Service Document. Recognized protocol descriptors
are validated and unknown protocol names are ignored. Unvalidated ODP document fields such as `http`
and `mcp` are not exposed. Reading results never contacts their source documents or endpoints.

## Search for Services only

`searchServices()` covers native ODP Service metadata, not imported Services, Collections, or catalogs.
To list Services across source formats, use `search({ types: ["service"] })`. A source filter does
not broaden `searchServices()` beyond ODP; filtering it to OpenAPI returns no matches.
Filter values within one
category use OR semantics; different categories combine with AND semantics. The initial page can
include facets for keywords, enrollment protocols, payment protocols, individual protocol payment
options, trust protocols, and ODP operation descriptors.

```ts
import { createDirectoryClient } from "@offering-protocol/directory";

const directory = createDirectoryClient();
const results = directory.searchServices({
  query: "GPU compute",
  filters: {
    keywords: ["gpu", "accelerator"],
    payments: [{ authentication: "not-required", name: "mpp", options: ["inflow", "solana"] }],
    trust: [{ name: "tap" }]
  },
  limit: 25
});

for await (const service of results.items) {
  useService(service.service_origin);
}
```

Options within one payment filter are alternatives. The example matches Services that accept either
InFlow or Solana through MPP. A protocol-only `{ name: "mpp" }` filter matches any Service that
advertises MPP. Responses keep protocol counts in `facets.payments`, expose singular
protocol-option counts in `facets.payment_options`, and report trust protocol counts in
`facets.trust`. A `{ name: "tap" }` trust filter restricts results to Services that advertise TAP.

`items` and `pages` are independent lazy traversals. Each begins with `POST /v1/services/search` and
retrieves opaque continuation links with `GET`. Continuations and redirects must remain on the
selected canonical origin.

A traversal follows the result set to its end unless the caller bounds it. `maxPages` and `maxItems`
are both optional; reaching either ends the sequence without an error, and the last page a `pages`
consumer received still carries its `next` reference, so a bounded traversal can be resumed with
`continueSearchServices`. A directory that repeats a cursor is rejected as a pagination loop.

Short-lived clients resume a returned `next` reference with `continueSearchServices`. The client
validates the canonical origin and retrieves the continuation with GET without interpreting it.

Every result contains the Service origin, cached Service Document metadata, and `indexed_at`, which
records when that directory entry was refreshed. A directory result is a candidate, never
authoritative catalog data: the agent inspects the live Service before navigating its Collections or
Offerings.

Compatible results may advertise protocol names unknown to this package. The client filters those
descriptors and preserves recognized enrollment, payment, and trust descriptors, including TAP.
Unknown members of a result are passed through for forward compatibility, but Service Document
members this client does not validate — `http`, `mcp`, `odp_version`, `payment_origins`, `branding`
and `search_capabilities` — are removed, so nothing on the result appears schema-checked when it is
not. The client never contacts a Service, or an MCP endpoint it advertises, while reading results.

An entry the client cannot validate is dropped from `items` and described in the page's `issues`
array rather than failing the whole page, so one stale directory entry cannot make every other
Service undiscoverable.

## Suggestions

`suggest()` finds matching index rows across Service and Collection names, descriptions, and
Service keywords, then returns the **names of matching targets**. Matching is case-insensitive
substring search, despite the input parameter being named `prefix`. For example, `we` can match
`weather` in a description and return the Collection name `AccuWeather`.

```ts
const names = await directory.suggest({
  prefix: "we",
  limit: 10,
  filters: { sources: ["openapi"], payments: [{ name: "mpp", options: ["inflow"] }] }
});
// Use a selected name as the query for directory.search().
```

The endpoint is `POST /v1/directory/suggestions`. Optional `filters` use the same structure as search,
including sources, keywords, AEP, ODP operations, payments, and trust. An ODP operation filter does
not match an imported Service simply because it has OpenAPI endpoints. Collection filters apply to their owning
Service. Suggestions are deduplicated search strings, not
resource identifiers. They do not tell you which target type supplied each name. The server ranks
names by the total number of matching index rows, then alphabetically, and returns at most 25.
Collection suggestions do not require permission to display that Collection's landing-page card.

`suggestServices()` calls `GET /v1/services/suggestions` and returns matching **Service keywords**
beginning with the prefix. It does not accept filters. Pair it with `searchServices()` for Service-only workflows. Natural-language interpretation
is not required by the directory contract. The client de-duplicates the response and returns at most
25 suggestions whatever the server sends.

```ts
const suggestions = await directory.suggestServices({ prefix: "gp", limit: 10 });
```

## Errors

Invalid local arguments throw `TypeError`, except numeric bounds such as `limit`, `maxItems` and
`maxPages`, which throw `RangeError`. HTTP failures throw `DirectoryRequestError`, which preserves
the response status and headers and exposes `code` and `retryable` so one retry helper can serve
this package and `@offering-protocol/agent` alike. Its message is derived from the response body
only when the body claims to be JSON, and is capped and stripped of control characters first. The
client rejects cross-origin redirects and continuations before retrieving them.

## Related Documentation

- [Agent integration](../agent/README.md)
- [Core models and validation](../core/README.md)
- [Canonical directory](https://directory.inflowpay.ai/)
- [Normative specification and schemas](https://www.offeringprotocol.org/)
