# Paseo profile sets implementation plan

Build a separate, file-backed library of agent profile sets. The library supports importing, exporting, updating, and managing sets independently of Paseo's current agent profiles. Applying profiles to a connected host is an explicit operation.

Use YAML 1.2 with JSON-compatible values. Target Paseo 0.11.2 as the verified initial SDK and runtime baseline. [Research](research.md) records the contracts and repositories behind these decisions; [team ownership](team.md) assigns the work.

## Product behavior

| Action | Library effect | Paseo effect |
| --- | --- | --- |
| Save selected current profiles as set | Create a named set | None |
| Export current profiles or saved sets | Produce YAML for the selection | None |
| Import sets | Create or explicitly update library entries | None |
| Update existing set | Replace its contents after review; retain the previous version | None |
| Update from current profiles | Refresh an existing set while retaining its portable identity | None |
| Add selected to Paseo | Preserve a recovery snapshot | Add or explicitly replace selected profiles; retain unrelated profiles |
| Use set | Preserve a recovery snapshot | Replace the complete ordered agent-profile list |
| Update and use | Update the library entry and preserve both previous states | Apply the reviewed updated set |
| Rename, duplicate, or delete a library entry | Change the saved entry; duplication creates a new portable identity | None |

Saving a set establishes a reusable identity. For ongoing sharing, Jamie saves a set once, updates that set from his current configuration, and exports it again. Ad hoc exports of current profiles can also be imported, with manual matching when their identities differ.

Changes to the catalog affect subsequent profile selections and orchestration discovery. Existing agents and already-materialized composer settings retain their values. Display **Matches current** when a set's complete ordered profile contents equal the live catalog; derive this from data rather than persisting an authoritative active-set ID. Multiple identical sets may match.

## Separate storage

Default storage is on the selected daemon host:

```text
$PASEO_HOME/plugin-data/paseo-profiles/
  sets/<local-set-id>.yaml
  state/
    activation.lock/
    libraries/<library-root-key>/
      imports/<local-set-id>.json
      history/<local-set-id>/<revision>.yaml
      operations/<operation-id>.json
      snapshots/<operation-id>.json
```

The `sets/` directory is configurable. Opening another library folder changes the library being viewed; it does not move files or change Paseo's current profiles. Keep provenance, history, recovery snapshots, and operation journals in host-local `state/`, scoped to the resolved library root. The root key prevents state from one library being mistaken for another library's state.

Use native plugin settings only for the folder preference. These external library and state files survive plugin reload, update, disable, and removal. Removing the plugin deletes its settings preference; a custom library folder must be selected again after reinstalling. History is retained in the MVP; automatic pruning is deferred.

This is a proposed application directory implemented with Node filesystem APIs. Paseo does not expose a server storage-directory accessor. Resolve the inherited `PASEO_HOME`, falling back to `~/.paseo` with home expansion. Show the resolved host path in the UI.

Support local filesystems first. A user can keep YAML files in a Git-managed folder; the plugin does not perform Git operations. Concurrent writes from multiple hosts, cloud-sync reconciliation, and remote subscriptions are outside the initial release.

## Portable documents and identity

One YAML document represents one set. Import and export several sets as several files, avoiding a second archive format.

```yaml
format: paseo-profile-set
version: 1
id: 56bb6b0f-72b2-49e8-9a01-29fbb061723a
name: Jamie Engineering
origin:
  fingerprint: sha256:0000000000000000000000000000000000000000000000000000000000000000
profiles:
  - id: engineering-review
    name: Engineering review
    provider: codex
    model: example-model-id
    notes: |
      Review correctness and implementation tradeoffs.
    featureValues:
      example_option: null
```

The example's fingerprint, model, and feature IDs illustrate the data shape; real fingerprints are computed and discovery on the destination host determines setting availability.

`id` is the portable source-set identity and remains stable across updates and exports. New sets use generated UUIDs. Local library filenames use independent generated IDs. Duplicating a set or importing incoming contents as a new set creates a new portable ID. Source IDs and names are data, never filesystem paths.

Include an origin fingerprint as the user proposed: SHA-256 over a versioned canonical tuple containing the exporting source's persistent daemon ID and canonical source path. Read the daemon's persisted `server-id`; do not use a hostname as a stable machine identity. Export the fingerprint rather than the raw machine ID/path. When first capturing profiles, record this origin; imports and reexports retain it. A copied set retains origin metadata and records its source set ID as `copiedFrom`, while receiving a new set ID. Never append text to or manually override a calculated hash to create a copy.

The three identities have different jobs: origin fingerprint groups files from the same source, set ID identifies the particular set across moves and machines, and a recomputed content hash detects changed data. One machine/path can produce several subsets, so origin equality alone only suggests replacement candidates. Matching a stable set ID can still identify Jamie's set after the source path changes. Content hashes are derived on read/export and stored in local tracking metadata; users do not maintain a self-referential hash field in YAML. Origin metadata is a matching aid rather than proof of authorship.

Preserve profile IDs, ordering, optional omissions, empty values, multiline notes, icons, colors, feature values, and unknown JSON-compatible profile fields. Exporting a subset creates a new set identity, so a partial file cannot silently replace a complete source set. Output contains only the selected profile records and portable set metadata; provider credentials and settings elsewhere in daemon configuration are excluded. Also accept raw Paseo JSON configuration: extract only `daemon.agentProfiles` from persisted configuration, or `agentProfiles` from the mutable SDK-shaped document, and ignore all other fields. Saved sets require at least one profile; internal recovery snapshots may contain an empty list.

Parse and serialize on the server using the locked `yaml` package. Use YAML 1.2 core resolution plus explicit JSON-value validation, rather than the parser's narrower `json` schema, which rejects ordinary unquoted text. Inspect document errors and the AST before conversion: reject duplicate mapping keys, aliases, custom tags, non-string keys, duplicate profile IDs, nonfinite numbers, and non-JSON objects. Bound bytes, document depth, file count, and profile count before expensive work; set initial limits against the verified RPC transport during scaffolding.

Round-trip guarantees concern profile data, not exact YAML whitespace or comments. Keep exact previous file bytes in history before rewriting an edited document.

## Updating Jamie's set

Store each import's source-set ID, origin fingerprint, complete imported baseline, and baseline content hash in host-local metadata. Compare the previous import, current local contents, and incoming contents to identify local edits.

1. Match the incoming stable source ID to saved entries and use the origin fingerprint to suggest related candidates. An unmatched ID defaults to **Create new set**. Offer **Update an existing set** for manual matching when the file has no identity or its ID changed; several matches require an explicit target choice. Every replacement still requires the change preview and the user's explicit action.
2. Show added, changed, removed, and locally edited profiles. Matching names can suggest candidates but never authorize replacement.
3. Offer **Update existing set**, **Import incoming as a new set**, or cancel. If incoming contents equal the previous imported baseline, preserve local edits and report **Source unchanged; local changes retained**. If incoming contents already equal the current local set but differ from the baseline, advance import metadata without rewriting the head. A complete no-op requires both contents and import metadata to be unchanged.
4. Updating replaces the whole selected set, including profiles Jamie removed. Local edits require an explicit **Replace local changes** choice; importing incoming contents as a new set keeps the edited existing set intact. Preserve the previous head and import metadata before committing.
5. **Update saved set** changes the library only. **Update and use** presents both the saved-set diff and a **Replace current agent profiles** review before either commit. It replaces the complete live catalog and can remove unrelated profiles. To preserve unrelated profiles, update the library and then use **Add selected to Paseo**. If applying fails after the library update succeeds, report those two outcomes separately.

Hashes establish equality and local revision checks. They do not establish publisher authenticity or which version is newest. Timestamps are advisory. Automatic network fetching and three-way automatic merges are deferred.

For individual profiles, **Add selected to Paseo** offers Skip, Keep both, and Replace a selected target. Exact duplicates default to Skip; differing collisions default to Keep both, with the proposed new ID/name shown. Replacement uses complete records so cleared fields stay cleared. Replace by confirmed ID/target, preserve unrelated profiles and their order, and append additions in source order. Jamie's removals affect the saved set; this additive path does not automatically remove profiles previously added to Paseo.

## Native UI and file delivery

Register **Agent profile sets** as a screen with a sidebar entry and global Command Center action. Use the host-owned header and host picker. Keep two sections: **Library** and **Current agent profiles**. Use the plugin's native Settings screen for **Library folder**.

Reuse `SettingsSection`, `SettingsCard`, `SettingsRow`, `SettingsAction`, `SettingsSelect`, and `SettingsInput` from `@getpaseo/plugin/client/ui`. Focused selection, update, and apply reviews use the adaptive `Modal` and its sheet-aware input/list helpers from `/client/react-native`. Profile selection is a temporary multi-select; choosing a set uses **Use set**, not on/off switches. Use theme tokens, ordinary text sizes, a readable content column, and compact stacking.

Library rows show name, profile count, and **Matches current** when appropriate. A detail view exposes members, source/update information, and management actions. Keep action labels explicit about whether they change the library or Paseo. Unavailable providers/models produce visible warnings; retain their stored settings rather than substituting values.

| Client | Import | Export |
| --- | --- | --- |
| Browser and Electron web runtime | Choose YAML/JSON files; host path; OS paste | Download YAML; write to host path; copy |
| iOS and Android | Read from host path; OS paste | Write to host path; copy |

The SDK has no native document picker, downloader, or share-sheet API. Gate browser file APIs in `client/web.ts`; never imply a host path is a file on the viewing device. Report download initiation accurately; report a host-file save only after the write succeeds, and clipboard success only after `copyText` resolves. A native device file picker needs additional host SDK support.

Canceling review changes nothing. Keep drafts through errors, refuse duplicate submissions, and distinguish loading, empty, invalid-file, inaccessible-folder, offline, pending, and ambiguous-result states. Changing hosts or library roots must not silently discard a draft. Refresh the library on focus, a manual Refresh action, and successful writes; reading changed files never applies them automatically.

## Backend boundaries and recovery

Keep shared Zod contracts runtime-neutral. A portable profile schema mirrors the verified public profile shape and retains unknown JSON fields; do not import unsupported runtime protocol modules into client-reachable code. Put YAML, crypto, filesystem access, locks, and Paseo mutation orchestration under `server/`.

Expose typed RPCs for list/read, import preview/commit, create/update/duplicate/delete, export, apply preview/commit, and history/recovery inspection. Use the existing Paseo SDK inside handlers for `config.get()` and `config.patch({ agentProfiles: target })`. Never write Paseo's config file directly. Observe `status.daemon_config_changed`, read initial state, and reread after reconnection; release subscriptions on teardown.

Library mutations carry the expected raw-file revision; semantic fingerprints use canonical JSON with object keys sorted and array order preserved. Pin previews to the library root, source revisions, and immutable target contents.

Serialize cooperating library writers with an in-process queue and a directory-level advisory lock. Verify revisions under the lock, save history first, write and flush a unique temporary file in the destination directory, then publish atomically. New entries need exclusive creation/publication; plain rename does not prevent overwriting an existing file. Reject traversal and symlinked entry files. A journal makes head, metadata, and history updates recoverable; do not claim multi-file transaction atomicity.

Serialize all cooperating live apply/recovery operations through the host-local `state/activation.lock`, including operations opened from different library folders or plugin installations. Combined operations acquire the host lock before library locks, with a consistent lock order. Library locks alone cannot coordinate access to the host's single current profile catalog.

For an operation that changes Paseo:

1. Acquire the host activation lock, then required library locks; reread the selected set and current profile list and refuse a stale preview. Keep the host lock through verification and journal completion.
2. Persist the exact current profiles and a prepared journal containing operation ID, library root, source revision, before fingerprint, and target fingerprint. Failure here prevents application.
3. Under the host activation lock, check fresh live state and patch only `agentProfiles`.
4. Verify the returned/current list before recording completion.
5. After a timeout, restart, or lost acknowledgment, compare live state to before/target. If it matches the target, record success without repeating the write; if it matches neither, require a fresh recovery decision. Never automatically restore over divergent state.

Expose two distinct restore actions. **History → Restore saved version** updates only the library entry, preserving its current head in history. **Current agent profiles → Restore previous list** previews and applies a recovery snapshot to Paseo through the host activation lock. An absent `agentProfiles` field can be restored semantically as `[]`; the SDK offers no delete-field operation.

**Concurrency limit:** Paseo's config API has no compare-and-swap. Fingerprints catch observed stale state, and the lock serializes cooperating plugin operations, but another client can edit profiles between the final read and patch. Guaranteed exclusion of that race requires upstream conditional config writes. Likewise, advisory file locks do not exclude arbitrary external editors. Basic library management and switching remain feasible with these documented limits.

## Build sequence and ownership

| Phase | Owner | Deliverable and exit gate |
| --- | --- | --- |
| 1. Scaffold and contracts | Lead Architect + Principal Engineer | Plugin scaffold, pinned 0.11.2 tooling, YAML dependency/lockfile, schema and RPC boundaries; both runtime bundles load |
| 2. Library and transfer | Principal Engineer | File store, revisions, source baselines, history, import/update/export, current-profile projection; lossless and interruption tests pass |
| 3. Native surfaces | Staff Engineer II | Library/current screens, selection/update reviews, directory settings, browser and host-file adapters; compact/light/dark review by Customer Advocate |
| 4. Apply and recover | Principal Engineer + Lead Architect | Add selected, Use set, Update and use, config event updates, preserved before-state and ambiguous-result recovery |
| 5. Verification and packaging | Senior SDET + Lead Architect | Isolated daemon/browser flows, actual platform evidence, typecheck/lint, package contents and install/reload checks |

Phases 2 and 3 run in parallel after contracts stabilize. Engineers own their directories; the lead integrates entrypoints and shared contract changes. Tests follow the changed behavior and run in one coordinated lane. The Paseo checkout remains read-only; keep plugin tests and harness adapters in this project.

Planned source layout:

```text
paseo-plugin.json        package.json          package-lock.json
tsconfig.json           OVERVIEW.md
index.client.tsx        index.server.ts
shared/set.ts           shared/rpc.ts         shared/preferences.ts
shared/import-plan.ts   shared/canonical.ts
client/library-screen.tsx                     client/current-profiles.tsx
client/import-review.tsx                      client/apply-review.tsx
client/library-settings.tsx                   client/web.ts
server/library-store.ts                       server/import-service.ts
server/yaml.ts          server/profile-service.ts
server/activation.ts    server/recovery.ts     server/host-files.ts
tests/                  tests/e2e/
```

## Acceptance and release gates

- Export one profile, a selected subset, and multiple sets; reimport without losing fields, order, omissions, or nested nulls. No unrelated config appears in output.
- Import several files into the library without changing Paseo. Duplicate IDs, malformed/bounded-out YAML, and unresolved conflicts cause no mutation.
- Reimport Jamie's unchanged set without duplication. Review and replace a changed set, including removals and local edits; **Import incoming as a new set** preserves both. The same origin with different sets/subsets never causes an automatic replacement; moving a source does not break a stable set ID. History can restore the previous head.
- Add or replace selected profiles while preserving unrelated current profiles; Use set applies the complete reviewed ordered list. Only `agentProfiles` changes, and running agents retain their settings.
- Fail preservation, stale-file checks, settings-root changes, or observed stale previews before applying. Resolve lost responses by rereading state; do not repeat an ambiguous mutation blindly.
- Verify library data survives plugin removal/reinstall, custom-root reopening, and daemon/plugin restarts. Inaccessible files remain visible as errors rather than disappearing into an empty state.
- Exercise browser file transfer, host-file read/write, clipboard rejection, double submission, two hosts, and peer-client config changes. Inspect wide and compact layouts in light and dark themes; record native coverage explicitly.
- Run focused unit/integration/E2E checks, typecheck, lint, and package dry-run. Reuse the isolated daemon and app-fixture patterns identified in [research](research.md); do not run Paseo's full suite or restart the main daemon on port 6767.

Finish with a working development install on an isolated daemon, a clean runtime catalog/log, an accurate `OVERVIEW.md`, and an npm/Git package containing both entries and production YAML dependencies. Publication and marketplace submission are later steps.
