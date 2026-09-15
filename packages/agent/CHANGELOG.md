# @offering-protocol/agent

## 0.4.3

### Patch Changes

- [#57](https://github.com/offering-protocol/odp-node/pull/57) [`a6dfb9e`](https://github.com/offering-protocol/odp-node/commit/a6dfb9e77d3fadef0a64d955e0a1ed0cdbfa1dca) Thanks [@nkavian](https://github.com/nkavian)! - Update the Agent HTTP transport dependency.

- [#52](https://github.com/offering-protocol/odp-node/pull/52) [`e2befe8`](https://github.com/offering-protocol/odp-node/commit/e2befe8d5f4b9adcc51633834d5f7377eb2f5014) Thanks [@zhoodar](https://github.com/zhoodar)! - Improve ODP conformance, validation, transport safety, caching, and failure handling across the Agent, Directory, and Service packages.

- Updated dependencies [[`73447fc`](https://github.com/offering-protocol/odp-node/commit/73447fc45eda1d8cf59deacd25922617cb19c0c0), [`e2befe8`](https://github.com/offering-protocol/odp-node/commit/e2befe8d5f4b9adcc51633834d5f7377eb2f5014)]:
  - @offering-protocol/directory@0.2.6

## 0.4.2

### Patch Changes

- [#49](https://github.com/offering-protocol/odp-node/pull/49) [`2106032`](https://github.com/offering-protocol/odp-node/commit/210603273b4ef7f1a4f156148a7633bb7656d85e) Thanks [@nkavian](https://github.com/nkavian)! - Support Node.js connection attempts that request all validated DNS addresses.

## 0.4.1

### Patch Changes

- [#47](https://github.com/offering-protocol/odp-node/pull/47) [`4ee9807`](https://github.com/offering-protocol/odp-node/commit/4ee9807483e40c9fe2b45e4c8c6a2ac11cb4b1ae) Thanks [@nkavian](https://github.com/nkavian)! - Update schema resolution dependencies to their latest compatible releases.

## 0.4.0

### Minor Changes

- [#44](https://github.com/offering-protocol/odp-node/pull/44) [`34d50e2`](https://github.com/offering-protocol/odp-node/commit/34d50e2a55f4d9559a97aab95ffebf91af3b2e75) Thanks [@nkavian](https://github.com/nkavian)! - Allow Service inspection and operation requests to use distinct transports.

### Patch Changes

- [#44](https://github.com/offering-protocol/odp-node/pull/44) [`34d50e2`](https://github.com/offering-protocol/odp-node/commit/34d50e2a55f4d9559a97aab95ffebf91af3b2e75) Thanks [@nkavian](https://github.com/nkavian)! - Keep Service authoring strict while Agent readers isolate unrecognized optional capabilities, unsafe Action extensions, and unsupported protocol descriptors.

- [#41](https://github.com/offering-protocol/odp-node/pull/41) [`2ffd265`](https://github.com/offering-protocol/odp-node/commit/2ffd2656b82c641b0363d9b795c227a61e788e7a) Thanks [@nkavian](https://github.com/nkavian)! - Support TAP trust-protocol advertisement in Service Documents and Agent inspection.

- [#41](https://github.com/offering-protocol/odp-node/pull/41) [`2ffd265`](https://github.com/offering-protocol/odp-node/commit/2ffd2656b82c641b0363d9b795c227a61e788e7a) Thanks [@nkavian](https://github.com/nkavian)! - Enforce page, representation, schema-resolution, and secure default transport boundaries across Agent and Service workflows.

- Updated dependencies [[`34d50e2`](https://github.com/offering-protocol/odp-node/commit/34d50e2a55f4d9559a97aab95ffebf91af3b2e75), [`2ffd265`](https://github.com/offering-protocol/odp-node/commit/2ffd2656b82c641b0363d9b795c227a61e788e7a), [`2ffd265`](https://github.com/offering-protocol/odp-node/commit/2ffd2656b82c641b0363d9b795c227a61e788e7a)]:
  - @offering-protocol/core@0.3.6
  - @offering-protocol/directory@0.2.5

## 0.3.0

### Minor Changes

- [#24](https://github.com/offering-protocol/odp-node/pull/24) [`9d32b52`](https://github.com/offering-protocol/odp-node/commit/9d32b52829218ca871ac0603a07d446ac2730b8f) Thanks [@nkavian](https://github.com/nkavian)! - Support service branding and service-wide OpenAPI documents, including OpenAPI Action URL inheritance.

### Patch Changes

- Updated dependencies [[`9d32b52`](https://github.com/offering-protocol/odp-node/commit/9d32b52829218ca871ac0603a07d446ac2730b8f), [`9d32b52`](https://github.com/offering-protocol/odp-node/commit/9d32b52829218ca871ac0603a07d446ac2730b8f), [`9d32b52`](https://github.com/offering-protocol/odp-node/commit/9d32b52829218ca871ac0603a07d446ac2730b8f)]:
  - @offering-protocol/directory@0.2.1
  - @offering-protocol/core@0.3.0

## 0.2.0

### Minor Changes

- [#22](https://github.com/offering-protocol/odp-node/pull/22) [`8cc9c1c`](https://github.com/offering-protocol/odp-node/commit/8cc9c1c2007fc6dc08f30dec745ab4a29ec8d6ba) Thanks [@nkavian](https://github.com/nkavian)! - Implement typed operation, enrollment, payment, and Action authentication descriptors, authenticated-content signals, and access-context cache isolation.

- [#22](https://github.com/offering-protocol/odp-node/pull/22) [`8cc9c1c`](https://github.com/offering-protocol/odp-node/commit/8cc9c1c2007fc6dc08f30dec745ab4a29ec8d6ba) Thanks [@nkavian](https://github.com/nkavian)! - Add validated list and search continuation entry points for short-lived Agent clients.

### Patch Changes

- Updated dependencies [[`8cc9c1c`](https://github.com/offering-protocol/odp-node/commit/8cc9c1c2007fc6dc08f30dec745ab4a29ec8d6ba), [`8cc9c1c`](https://github.com/offering-protocol/odp-node/commit/8cc9c1c2007fc6dc08f30dec745ab4a29ec8d6ba)]:
  - @offering-protocol/core@0.2.0
  - @offering-protocol/directory@0.2.0

## 0.1.0

### Minor Changes

- [#6](https://github.com/offering-protocol/odp-node/pull/6) [`b01edad`](https://github.com/offering-protocol/odp-node/commit/b01edad0943e4596a608dc76ba9f62ad38dcb11a) Thanks [@nkavian](https://github.com/nkavian)! - Add typed Collection navigation, search, caching, and normalized filter discovery.

- [#8](https://github.com/offering-protocol/odp-node/pull/8) [`be5b7b4`](https://github.com/offering-protocol/odp-node/commit/be5b7b497f72bcdee34ebe457225767c6ddd539e) Thanks [@nkavian](https://github.com/nkavian)! - Add typed Offering catalog operations and correct JSON Schema reference models.

- [#9](https://github.com/offering-protocol/odp-node/pull/9) [`4a6377a`](https://github.com/offering-protocol/odp-node/commit/4a6377a216adbaf761862fc91590de3fd9745094) Thanks [@nkavian](https://github.com/nkavian)! - Resolve Offering Attribute Schemas and lazily resolve Action supporting documents.

- [#12](https://github.com/offering-protocol/odp-node/pull/12) [`ac1f7e4`](https://github.com/offering-protocol/odp-node/commit/ac1f7e463d0e761bb875be01683cad5e1ab82414) Thanks [@nkavian](https://github.com/nkavian)! - Add bounded two-stage discovery across the canonical directory and Service Offering catalogs.

- [#7](https://github.com/offering-protocol/odp-node/pull/7) [`72a01dd`](https://github.com/offering-protocol/odp-node/commit/72a01dd95437f5bcfcac394d7ec42a3c10fd6829) Thanks [@nkavian](https://github.com/nkavian)! - Cache explicitly fresh search responses by exact request and access context.

- [#4](https://github.com/offering-protocol/odp-node/pull/4) [`ef5cd1b`](https://github.com/offering-protocol/odp-node/commit/ef5cd1bcb15eb2c33f9f49948f1c286668454015) Thanks [@nkavian](https://github.com/nkavian)! - Add validated Service inspection with HTTP caching and normalized capability discovery.

- [#1](https://github.com/offering-protocol/odp-node/pull/1) [`a43822c`](https://github.com/offering-protocol/odp-node/commit/a43822c43933fe638c7cc9c125e08b9a62f26664) Thanks [@nkavian](https://github.com/nkavian)! - Establish the official ODP Node.js package boundaries and repository toolchain.

### Patch Changes

- [#14](https://github.com/offering-protocol/odp-node/pull/14) [`9e3ea26`](https://github.com/offering-protocol/odp-node/commit/9e3ea26171262e983a5c322ebd05dfb7332e433f) Thanks [@nkavian](https://github.com/nkavian)! - Harden bounded streaming, cancellation, Resource Identity checks, static catalog relationships, and stateless continuations across the Node.js reference implementation.

- [#13](https://github.com/offering-protocol/odp-node/pull/13) [`9194658`](https://github.com/offering-protocol/odp-node/commit/91946588fa6e58a859f8d4560d23704d022be9c8) Thanks [@nkavian](https://github.com/nkavian)! - Add runnable small-Service, marketplace-Service, and agent examples; omit empty Offering issues and
  alphabetize advertised Service operations.
- Updated dependencies [[`b01edad`](https://github.com/offering-protocol/odp-node/commit/b01edad0943e4596a608dc76ba9f62ad38dcb11a), [`be5b7b4`](https://github.com/offering-protocol/odp-node/commit/be5b7b497f72bcdee34ebe457225767c6ddd539e), [`9e3ea26`](https://github.com/offering-protocol/odp-node/commit/9e3ea26171262e983a5c322ebd05dfb7332e433f), [`94c5525`](https://github.com/offering-protocol/odp-node/commit/94c5525cee997c9004f6513aaac86fbc10ee110e), [`667c819`](https://github.com/offering-protocol/odp-node/commit/667c819bda517163ee248c63ae371cdc0210fa10), [`a43822c`](https://github.com/offering-protocol/odp-node/commit/a43822c43933fe638c7cc9c125e08b9a62f26664), [`ee4879e`](https://github.com/offering-protocol/odp-node/commit/ee4879e01b9d76abc0dbaca22f472e7bc43595d2)]:
  - @offering-protocol/core@0.1.0
  - @offering-protocol/directory@0.1.0
