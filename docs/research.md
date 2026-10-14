# Paseo profile packs research

Research date: 14 October 2026. Local source: `/Users/cchen/code/oss/paseo`, commit `e1a5664d9b615dcfcf88f4b3a0ba05234b219dce`; plugin/client/protocol package version 0.11.2. The supplied project directory was empty and had no Git repository.

## Verified contracts

| Finding | Evidence |
| --- | --- |
| Profiles are host-local named setting bundles; changing saved profiles affects later selections | [Agent profiles](https://paseo.sh/docs/agent-profiles) |
| Records require `id`, `name`, and `provider`; optional model, mode, thinking, features, notes, icon, color; unknown fields pass through | [Profile schema](https://github.com/getpaseo/paseo/blob/e1a5664d9b615dcfcf88f4b3a0ba05234b219dce/packages/protocol/src/agent-profile.ts#L12) |
| `config.get()` reads mutable configuration; `config.patch()` validates, persists, and applies a patch | [SDK reference](https://paseo.sh/docs/sdk/reference#clientconfig), [SDK signatures](https://github.com/getpaseo/paseo/blob/e1a5664d9b615dcfcf88f4b3a0ba05234b219dce/packages/client/src/index.ts#L466) |
| Updating profiles replaces the entire ordered list; there is no per-profile CRUD API | [Native hook](https://github.com/getpaseo/paseo/blob/e1a5664d9b615dcfcf88f4b3a0ba05234b219dce/packages/app/src/agent-profiles/internal/use-agent-profiles.ts#L12) |
| Config has no revision/CAS argument or supported default-profile field | [Patch signature](https://github.com/getpaseo/paseo/blob/e1a5664d9b615dcfcf88f4b3a0ba05234b219dce/packages/client/src/index.ts#L480), [supported patch fields](https://github.com/getpaseo/paseo/blob/e1a5664d9b615dcfcf88f4b3a0ba05234b219dce/packages/server/src/server/daemon-config-store.ts#L19) |
| Saved-profile changes do not automatically affect existing agents; the native UI can separately apply compatible settings to running agents | [Materialization](https://github.com/getpaseo/paseo/blob/e1a5664d9b615dcfcf88f4b3a0ba05234b219dce/packages/app/src/agent-profiles/internal/materialize-profile.ts#L45) |
| Observe config changes through `observeEvents(["status.daemon_config_changed"])`; there is no `config.subscribe()` | [Observation](https://github.com/getpaseo/paseo/blob/e1a5664d9b615dcfcf88f4b3a0ba05234b219dce/packages/client/src/daemon-client.ts#L2367), [payload](https://github.com/getpaseo/paseo/blob/e1a5664d9b615dcfcf88f4b3a0ba05234b219dce/packages/protocol/src/messages.ts#L3838) |
| Server plugin settings expose read/subscribe; client saves have revision checking. Settings are removed on uninstall | [Settings contract](https://paseo.sh/docs/plugins/reference#persisted-values), [server context](https://github.com/getpaseo/paseo/blob/e1a5664d9b615dcfcf88f4b3a0ba05234b219dce/packages/plugin/src/server/contracts.ts#L25) |
| Standard launch sets `PASEO_HOME`; plugin subprocess inherits the environment | [Launch environment](https://github.com/getpaseo/paseo/blob/e1a5664d9b615dcfcf88f4b3a0ba05234b219dce/packages/server/src/server/config-environment.ts#L76), [fork](https://github.com/getpaseo/paseo/blob/e1a5664d9b615dcfcf88f4b3a0ba05234b219dce/packages/server/src/server/plugins/runtime.ts#L233) |
| A stable daemon ID is persisted in `$PASEO_HOME/server-id`; it identifies the daemon rather than physical hardware | [Server identity](https://github.com/getpaseo/paseo/blob/e1a5664d9b615dcfcf88f4b3a0ba05234b219dce/packages/server/src/server/server-id.ts#L30) |
| Plugin removal deletes managed sources and plugin settings; the proposed external library is outside those locations | [Removal implementation](https://github.com/getpaseo/paseo/blob/e1a5664d9b615dcfcf88f4b3a0ba05234b219dce/packages/server/src/server/plugins/index.ts#L456) |

The proposed library directory, identity model, machine/path origin fingerprint, source baselines, history, and operation journals are plugin design decisions. They are not existing Paseo storage services.

## Visual and runtime integration

Use the public [plugin reference](https://paseo.sh/docs/plugins/reference) for supported registrations and module boundaries, and the checkout's [maintainer guidance](https://github.com/getpaseo/paseo/blob/e1a5664d9b615dcfcf88f4b3a0ba05234b219dce/docs/plugins.md) for implementation constraints. The [settings example](https://github.com/getpaseo/paseo/tree/e1a5664d9b615dcfcf88f4b3a0ba05234b219dce/plugin-examples/settings) and [modal example](https://github.com/getpaseo/paseo/tree/e1a5664d9b615dcfcf88f4b3a0ba05234b219dce/plugin-examples/modal-ui) demonstrate the host-owned components.

The SDK offers adaptive modals, sheet-aware inputs/lists, toasts, and clipboard copy, but no native file-picker/save/share API. Browser adapters belong in `client/web.ts` with platform guards. Only the published client runtime modules are available; keep YAML and filesystem dependencies server-side. The checkout's [design guidance](https://github.com/getpaseo/paseo/blob/e1a5664d9b615dcfcf88f4b3a0ba05234b219dce/docs/design.md) favors reused controls, restrained hierarchy, theme tokens, and compact layouts.

The Customer Advocate applied [Jakob's Law](https://lawsofux.com/jakobs-law/) to native controls and familiar file actions, and [Hick's Law](https://lawsofux.com/hicks-law/) to separating library import from Add/Use and offering a clear recommended collision policy.

## Community repositories inspected

Started from the [Paseo plugin directory](https://paseo.sh/plugins) and followed source links. These are design references, not runtime dependencies. Repository heads may differ from the marketplace's pinned revision.

| Plugin and inspected revision | Source paths and lesson |
| --- | --- |
| [Prompt Manager](https://paseo.sh/plugins/yannelli/prompt-manager), [source at d4f5dba](https://github.com/yannelli/paseo-prompt-manager/tree/d4f5dba00854296fd9c823503a7674dc8b5f069d) | `client/web.ts`, `client/import.tsx`, `server/library.ts`: actual browser selection, explicit host paths, bounded imports, filesystem-backed library and versions. Reuse the delivery separation; use current native controls for our UI. |
| [Paseo Accounts](https://paseo.sh/plugins/raffidahmad/accounts), [source at ebed610](https://github.com/raffidahmad/paseo-accounts/tree/ebed61032ff56db9c75a43421be7335805b2f3c4) | `server/providers.ts:101`, `index.server.ts`, `index.client.tsx`: public SDK config reads and whole-list profile writes, settings registration and cleanup. A fresh read alone does not provide CAS. |
| [Paseo SLP](https://paseo.sh/plugins/duongvm57/slp), [source at 5a77b58](https://github.com/duongvm57/paseo-slp-plugin/tree/5a77b5854b62601842969eea23915ab5fd5526b2) | `plugin/server/config-view.ts`, `plugin/server/config-transaction.ts`: canonical fingerprints, drift classification and recovery. Its larger provider/config transaction layer exceeds this plugin's scope; use the public SDK rather than direct config-file mutation. |
| [Project Notes](https://paseo.sh/plugins/zhjiang22/project-notes) and [Agent Observatory source at 9b829d7](https://github.com/zhjiang22/paseo-plugins/tree/9b829d7dcba3ab75357bf64bc14cc0933dbf1f99) | `project-notes/server/store.ts`, `server/launch.ts`, `agent-observatory/server/profiles.ts`: file revisions, atomic publication, recoverable operations, and projecting profiles without exposing unrelated config. Their abbreviated profile summaries are unsuitable for lossless export. |
| [Bots](https://paseo.sh/plugins/oliexe/bots), [source](https://github.com/oliexe/paseo-bots) | Staff inspected `index.server.ts`: separate import/export/upload handlers delegated to `server/share`; useful RPC/service decomposition. |
| [ZeroSub](https://paseo.sh/plugins/kapybara-org/zerosub), [source](https://github.com/kapybara-org/zerosub) | Staff inspected client/server entrypoints: preferences and a settings surface alongside its main screen. Avoid undocumented contribution aliases in favor of current public registrations. |

Staff also inspected [Workboard](https://github.com/fxbing/paseo-workboard) repository structure and technical documentation. Its private host bridge is not an appropriate dependency for this plugin. Four repositories above were cloned into temporary research directories and their implementation files read; none were installed or executed.

## YAML choice

Profiles can contain arbitrary nested JSON values, including null. TOML has no null value type, requiring an encoding convention to preserve all possible profile data. YAML supports these values and readable multiline notes. Use [yaml v2's document/AST API](https://eemeli.org/yaml/) with explicit validation. Its `json` schema rejects ordinary unquoted strings; use YAML 1.2 core resolution and then constrain the output data. [TOML value types](https://toml.io/en/v1.0.0#keyvalue-pair), [YAML specification](https://yaml.org/spec/1.2.2/).

## Validation patterns to reuse

- Isolated daemon helper: `packages/server/src/server/test-utils/paseo-daemon.ts`; temporary home and ephemeral port.
- Real plugin settings/runtime patterns: `packages/server/src/server/plugins/settings.e2e.test.ts`, `runtime.posix.test.ts`, and `plugin-paseo-api.e2e.test.ts`.
- App isolation: `packages/app/e2e/support/fixtures.ts` blocks accidental use of port 6767; `e2e/browser/plugin-settings.spec.ts` demonstrates peer clients and compact layouts.
- Follow checkout [testing guidance](https://github.com/getpaseo/paseo/blob/e1a5664d9b615dcfcf88f4b3a0ba05234b219dce/docs/testing.md) and [QA evidence requirements](https://github.com/getpaseo/paseo/blob/e1a5664d9b615dcfcf88f4b3a0ba05234b219dce/docs/qa.md). Adapt patterns in this plugin project; do not modify the Paseo checkout as part of the plugin MVP.

No implementation tests, live plugin installation, configuration edits, or daemon reloads were performed during research.
