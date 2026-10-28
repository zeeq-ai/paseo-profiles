# Publishing profile packs to GitHub Gists

Implementation status: implemented for 0.2.0, 28 October 2026. See [verification](verification.md) for the tested behavior and remaining limits.

## Decision

A saved pack has one invariant **pack ID** and at most one **active Gist target**. Editing and republishing the pack updates one named file in that Gist, creating a Gist revision when GitHub records a change. **Publish as a new Gist** creates a separate Gist, makes it the active target after confirmation, and leaves the previous Gist online. A new target does not create a new pack ID. A user who wants independent lineage duplicates the pack first.

A local edit immediately marks the pack **Unpublished changes**. The plugin never writes to GitHub merely because a pack changed; the user opens a review and confirms **Publish revision**.

The user chooses where the Gist link is saved: on this Paseo host, in a sidecar file in a user-entered Git repository on that host, or inside the portable pack YAML. GitHub requests run as the `gh` account on the selected Paseo host. Publication uses REST `PATCH` and accepts last-write-wins in the narrow interval after the final read. Known remote changes are still shown before confirmation.

The [publication service](../server/gist-publication.ts) extends the [Gist transport](../server/gists.ts) and [pack detail UI](../client/gist-publication.tsx). Ad-hoc multi-pack `gist.create` remains unlinked. The [pack schema](../shared/set.ts) keeps the portable `id`; the [library store](../server/library-store.ts) has separate local file IDs, revisions, and import baselines.

## Identity and data ownership

| Value | Meaning | Stability |
| --- | --- | --- |
| `set.id` | Portable pack lineage | Invariant across edit, import update, relink, publish revision, and publish as new. Duplicate, subset export, and Import as copy mint a new ID. Existing non-UUID IDs remain valid. |
| `origin.fingerprint` | Hash-based hint that two packs came from the same Paseo configuration | Never treated as identity, ownership, or a publication target. |
| `localId` | Filename key in this host's library | Local only; it can differ across hosts. |
| Gist ID + exact filename | Remote target | Changes on relink or Publish as new. The same Gist may hold several packs. |
| Gist revision | GitHub's version of the whole Gist | Changes when any Gist file changes; only the bound file is compared for pack drift. |
| Payload hash | Hash of the exact YAML sent for the bound file | Used to recognize the bytes published or read back. |

An ordinary update of an existing library pack preserves `set.id`. `library.save` rejects a replacement ID, and an import into an explicit target adopts that target's ID and link. Import as copy gets a new ID. The existing origin fingerprint remains a matching suggestion for older files, never a reason to silently overwrite a pack.

The Gist pointer is `{gistId, fileName}`. Publication state is separate: last confirmed Gist revision, exact published-file hash, last published pack-content hash, last check time, unresolved operation, and previous Gist links. The publication serializer includes the pointer only for the portable-YAML choice; it removes a prior pointer when changing to host or sidecar storage. The pointer may travel; tokens and unresolved operation journals never do. A Gist revision or a hash of the whole file must not be embedded in that same file: writing it would change the revision or hash it claims to describe.

## Link storage: a per-pack choice

| Choice in the UI | Where the pointer lives | What travels |
| --- | --- | --- |
| **This Paseo host only** (default) | `$PASEO_HOME/plugin-data/paseo-profiles/state/libraries/<root-hash>/gist-links/<localId>.json` | Nothing in a pack export or Git repo. A moved library root must be relinked because existing host state is keyed by its canonical path. |
| **In a Git repository on this host** | `<user-entered-repo>/.paseo-profiles/gists/<sha256-pack-id>.json` | The sidecar file can travel when the user commits and pushes it. The plugin does not perform Git commits, pushes, or pulls. |
| **Inside this pack file** | A v2 portable YAML field, `gist: { id: ..., file: ... }` | Full-pack exports and Gist publications carry the link. A subset export or Duplicate strips it because those actions create a new pack ID. |

For the repository choice, the user enters or confirms an absolute directory on the **selected Paseo host**. The plugin resolves it, verifies it is a Git worktree, displays the exact sidecar path before saving, and writes only under its own `.paseo-profiles/gists/` directory. The filename uses a hash because existing pack IDs are arbitrary nonempty strings, not guaranteed safe path segments; the sidecar itself records and validates the full pack ID. Selecting a folder alone does not share the link. Host-local metadata remembers which repo path to reopen, while the shareable sidecar is keyed by the stable pack ID. A fresh clone must go through Link Gist and select that repository; the plugin does not scan arbitrary repositories for sidecars.

The sidecar can contain the pointer and last confirmed publication state; the host-only record contains the same fields. Operation journals and confirmation of an untrusted pointer stay host-local. A sidecar in a Git working tree may diverge across clones. On opening it, the plugin checks the actual Gist rather than trusting the sidecar's claimed revision. On a host that has not confirmed that pointer and baseline before, the first publish requires a full remote comparison and explicit target confirmation even if the sidecar says **Up to date**. Git sharing happens only after the user commits and pushes that file.

The portable YAML option requires a **v2 reader and writer**. The current v1 schema is strict, so older plugin versions reject any new top-level field even if `version` stays `1`. v2 makes the incompatibility explicit, while the new reader continues to accept v1. Choosing this option shows the minimum plugin version and upgrades this pack. A semantic-content hash excludes the location-only `gist` field when describing profile changes, while **Up to date** also requires the exact remote file to match the intended YAML. A pointer-only difference appears as **Link change to publish**. Moving the pointer or first adding it saves a new local version.

Anyone who receives a portable pack or repository sidecar can follow a secret Gist link and inspect its history. Secret Gists are unlisted, **not private**. The link-location choice names this consequence, particularly for public repositories. [GitHub's Gist visibility documentation](https://docs.github.com/en/get-started/writing-on-github/editing-and-sharing-content-with-gists/creating-gists) supports this wording.

When multiple locations contain different pointers, show **Link conflict** and block publishing. The user must choose the active target and confirm its owner, file, and pack ID. Never silently prefer one pointer. Identical pointers in two locations are not a conflict, but the UI shows both locations and requires one to be chosen before a later storage change. A copied or Git-pulled pointer is untrusted until this host has shown those details and the user confirms it. Live GitHub ownership and authorization, rather than the stored pointer, decide whether publishing is available.

Restoring a saved local version may restore an older portable pointer. The implementation detects that the pointer is no longer confirmed on this host and blocks publishing until it is confirmed again. A separate pointer-change diff in the history restore preview remains deferred.

## Functional journeys

### Link an existing Gist

1. From a saved pack, choose **Link Gist…**, paste a full `https://gist.github.com/...` URL, then **Check Gist**. Show the selected Paseo host, effective `gh` account, Gist owner, actual public/secret visibility, and available filenames.
2. Select the exact `.yaml` or `.yml` file. If exactly one file has the same pack ID, suggest it; never choose an ambiguous match. A file with a different pack ID cannot be overwritten by this flow. A new YAML filename in a Gist the account owns is allowed after explicit review and is recorded as **Pending first publish**; the first publish adds that file. If an established bound file later disappears, publishing blocks instead of silently adding it back. Existing JSON files remain importable through the current flow, but this YAML publication flow does not rewrite a `.json` file with YAML content.
3. Choose the link location and review its full host path or portable-file consequence. **Link Gist** writes only the chosen local location; it does not write to GitHub or change Paseo's live profiles. A foreign Gist can be linked for update checks and imports, while publishing to it is unavailable.
4. Confirm the pointer on this host. For an existing matching remote file, treat its current version as the initial comparison baseline. If the saved pack differs, show the difference and require the first publication to be reviewed.

### Publish a revision

1. **Publish revision…** reads the bound file, confirms its `set.id` matches the saved pack, checks the effective `gh` account and owner, and shows a named diff of profiles and shared prompt. It says which file will be replaced and how many other Gist files remain untouched.
2. If only the saved pack changed, the primary action is **Publish revision**. If the remote file changed, show its changes and offer **Review replacing my saved pack with the Gist version**, **Overwrite the Gist file with my saved pack**, or **Publish as a new Gist**. No implicit merge. Previous saved-pack versions stay in local history. An unrelated Gist file changing does not count as this pack's conflict.
3. Immediately before writing, reread the bound remote file. If it changed since the review, return to the review with the new diff. Otherwise PATCH only `files[exactFilename].content`, without sending `description` or other files. A concurrent edit after this reread can still be overwritten; the user has accepted last-write-wins. GitHub documents that omitted files are unchanged in [Update a Gist](https://docs.github.com/en/rest/gists/gists#update-a-gist), and does not document conditional PATCH support; its [conditional-request guidance](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api#use-conditional-requests) excludes unsafe methods absent an endpoint exception.
4. Read and verify the resulting bound-file content and record the returned version when it can be attributed to this write. GitHub may not create a new revision for an unchanged payload; in that case report **Already up to date**. Keep the last published baseline separate from the existing `ImportMetadata` baseline, which describes the last imported source and must retain Jamie-update semantics.

### Publish as a new Gist

The final button is **Publish and switch link**. The review states: “Future publishes use the new Gist. The old Gist stays online; people using its URL will not receive these updates.” The new Gist defaults to secret, with visibility and description visible before confirmation. After GitHub creation is confirmed and local link state is saved, the new pointer becomes active; the old pointer moves to an informational **Previous Gists** list. The pack ID stays the same. The new URL and **Copy URL** are prominent on success. If the `gh` account cannot publish to Jamie's Gist, this is the available publishing path; **Review updates** remains available for Jamie's link.

For the portable-YAML choice, the new Gist ID is unknowable before creation. The operation therefore has two remote steps: POST a file without the `gist` pointer, then PATCH that newly created Gist with the pointer to itself. This creates an initial and a completed remote revision. A journal records the new URL as soon as it is known; if the second step fails, show **Gist created; link embedding unfinished** and offer **Finish linking**, without creating another Gist. The active link switches only after the completed file and local state are confirmed. Host-only and repository-sidecar choices need one POST.

### Import and copies

The existing Gist import review remains the route for bringing a remote version into the library. **Review replacing my saved pack with the Gist version** opens it with the target and selected Gist file filled in; updating the library does not apply profiles to Paseo. Linking is a separate action in saved-pack details. Duplicating a pack or exporting a selected subset creates a new pack ID and removes its active Gist link. A full-pack export carries the link only if the user chose the portable-YAML location; **Exclude the Gist update link from this export** supports one-off sharing.

For example, Charles can keep a read-only link to Jamie's pack, inspect Jamie's new Gist revision, and explicitly import that version into his library. If Charles then chooses **Publish as a new Gist**, the pack keeps its ID but points future publications to Charles's Gist. Jamie's original Gist remains a previous source and is never edited by Charles's publication.

## State and failure handling

| State | User-facing outcome |
| --- | --- |
| No link | Link an existing Gist or Publish as new. |
| Saved pack changed, remote file unchanged | Publish revision after one review. |
| Remote file changed, saved pack unchanged | Review replacing the saved pack, overwrite remotely after explicit review, or publish new. |
| Both changed | Show both directions of change; the same three explicit choices. |
| Same content, different recorded baseline | Refresh publication state without a remote write. |
| Established file missing, mismatched pack ID, or conflicting pointers | Block in-place publish; review the target or publish new. Never silently recreate a missing filename or replace another pack. A deliberately chosen new filename uses the separate **Pending first publish** state. |
| Not owner | Show the host's `gh` account and Gist owner. Offer Review updates or Publish as new. Auth failure is a separate **Check GitHub account** state. |
| Outcome unknown after a sent request | Persist the operation across modal close and restart. Show **Check again**, **View on GitHub**, and **Close**; no automatic retry. Matching current content supports “Your changes are present on GitHub.” Different current content remains uncertain: a later writer may have replaced a successful publish. |

Before a GitHub write, persist an operation journal with its operation ID, local pack revision, bound target, and payload hash. After remote success, record the Gist ID/version and then update local link state; retain a journal if the local save fails so reopening can finish it without another remote write. The library lock is held for local file mutations, never across network calls. A repeated commit with the same operation ID returns or reconciles its prior result.

POST has no documented idempotency key. After a lost create response, search the account's recent Gists for plausible matches and verify exact file content and pack ID before adoption. Zero candidates does **not** prove no Gist was created, and several candidates require user selection. A deliberate repeat warns that it may create a duplicate. For PATCH, differing readback similarly cannot prove the earlier write failed; offer GitHub history for inspection. GitHub exposes Gist revisions through [Get a Gist revision](https://docs.github.com/en/rest/gists/gists#get-a-gist-revision).

## Technical contract

The portable choice adds one optional field to **v2** pack YAML. It holds a destination pointer, not a claim of authority or a revision:

```yaml
format: paseo-profile-set
version: 2
id: 2dbfbd3d-81eb-4ab2-90a4-45dd2ef67e2b
name: Fast review
gist:
  id: 3f9ac21e
  file: fast-review.yaml
profiles:
  - id: reviewer
    name: Reviewer
    provider: codex
```

A repository sidecar is a versioned record keyed by `sha256(packId)`; it also carries `packId` for validation. Its mutable publication baseline can be shared through Git, while the pending-operation journal stays under `$PASEO_HOME`. No machine/path hash is used as the portable pack identity.

```json
{
  "format": "paseo-profile-gist-link",
  "version": 1,
  "packId": "2dbfbd3d-81eb-4ab2-90a4-45dd2ef67e2b",
  "gistId": "3f9ac21e",
  "fileName": "fast-review.yaml",
  "lastConfirmedRevision": "<GitHub revision SHA>",
  "lastPublishedFileHash": "sha256:<hash>"
}
```

Typed server RPCs follow the existing `shared/rpc.ts` pattern:

| RPC | Important input | Result |
| --- | --- | --- |
| `gist.inspect` | URL or bound Gist ID | Owner ID/login, current `gh` account, actual visibility, exact file list and IDs, and revision. Inspection is stateless; link preview reads the selected file again. |
| `gist.link.preview` / `gist.link.commit` | Library root, `localId`, expected local revision, exact Gist file, storage choice, and repo directory if selected | Read-only comparison and destination preview; then a local-only link write with a confirmed pointer. |
| `gist.publish.preview` | Library root, `localId`, expected revision, `revision` or `new` mode | Short-lived preview ID, exact local/remote/baseline file hashes, named changes, owner, visibility, and permitted actions. |
| `gist.publish.commit` | Preview ID and an explicit remote-overwrite choice when needed | Journaled, idempotent result: published, already equal, remote changed before write, partial local save, or outcome unknown; new Gist URL and revision when confirmed. |
| `gist.publish.operation` | Persistent operation ID and action | Check an uncertain result without another write; explicitly finish an incomplete portable-link PATCH or pending local save, adopt a verified create candidate, or dismiss with the stated duplicate risk. |
| `gist.unlink` | `localId`, expected revision | Remove the active local pointer after review; leave the remote Gist and previous-link history intact. |

Every commit checks the current local revision and pointer, not only the preview's cached data. Remote responses must be checked for truncation and exact bound-filename content. The existing `gist.availability` only checks whether `gh` runs; account inspection additionally calls GitHub as the effective host-side `gh` identity. Compare the authenticated user's numeric ID with `gist.owner.id` to enable owner-only publishing, then let the write response determine whether its token has sufficient permission. `GH_TOKEN` or `GITHUB_TOKEN` can override a stored CLI login, so the UI reports the identity returned by that request. [Authenticated-user API](https://docs.github.com/en/rest/users/users#get-the-authenticated-user), [GitHub CLI environment behavior](https://cli.github.com/manual/gh_help_environment)

## Visual design

Reuse the existing Paseo `SettingsSection`, `SettingsCard`, `SettingsAction`, `SettingsSelect`, and adaptive `Modal`. The current [library screenshot](../assets/library.png) supplies the list hierarchy; the [apply review](../assets/use-preview.png) supplies the named-diff pattern. The new Gist section sits in saved-pack detail after the pack's content and before secondary Library/Paseo management. Keep the everyday action first and use plain status text rather than a row of badges.

```text
Fast review · 2 profiles

GitHub Gist
  @charles on Mac Studio  →  @charles/3f9a… · fast-review.yaml
  Secret · Unpublished changes · Link in repo
  [Publish revision…]     [Publish as new Gist…]
  Check for updates       [Review updates]
  Gist link and history   [Manage…]

Publish revision                                      [×]
  Publish as @charles using Mac Studio
  Update fast-review.yaml · 2 other files stay unchanged
  Secret Gist: anyone with its URL can read past revisions
  Your changes
    Review model: gpt-6-sol → gpt-6.1-sol
    Shared prompt: 1 paragraph changed     [Show full text]
  [Publish revision]
```

**Manage Gist link** uses one progressive sheet: Check URL → select file → select **Where to save this link** → review the exact destination → Link. The location choices read **This Paseo host only**, **In a Git repository on this host**, and **Inside this pack file**. The repository choice shows a host-path input and the resulting sidecar path. No row says merely “Choose file” for a host path. Linking copy ends with “Nothing is sent to GitHub.”

```text
Link Gist                                           [×]
  Paseo host: Mac Studio · GitHub account: @charles
  Gist URL  [https://gist.github.com/jamie/3f9a…]  [Check]
  Owner @jamie · Secret · Read-only for @charles
  File for this pack  [fast-review.yaml ▾]  Same pack ID

  Where to save this link
    ( ) This Paseo host only
    (•) In a Git repository on this host
    ( ) Inside this pack file
  Repository folder  [/Users/charles/team-profiles]
  Saves: /Users/charles/team-profiles/.paseo-profiles/gists/…json
  Teammates receive this link when you commit and push that file.
  Anyone with a secret Gist URL can view it and its history.
  [Link Gist]  Nothing is sent to GitHub.
```

On a known remote conflict, replace the ordinary diff with before/after details and the three choices; do not bury a destructive choice behind a generic button. The review explicitly states that REST publishing keeps the last write and that an edit made during publishing could be overwritten. A read-only Jamie link shows **Review updates** as the primary action and **Publish as a new Gist…** as secondary. Separate **Gist history on GitHub** from **Saved versions on this host**; the MVP can open Gist history on GitHub rather than embedding a remote history browser.

Follow the current plugin spacing: 16 px card content inset, 8 px gaps within a content group, 12 px between sections, and at least 44 px touch targets. Native `SettingsAction` rows own their padding; custom diff text and fields get the 16 px inset. At 390 px, stack account, target, diff, and actions in the adaptive sheet. Show statuses as words, not color alone. Blocking errors use an accessible alert; return focus to the triggering action on close. The list uses cached status and never fetches GitHub for every row; a detail check labels its last-check time.

## Delivery sequence and acceptance gates

1. Add v1/v2 pack reading, publication-state schemas, and tests for invariant IDs, copy stripping, sidecar path validation, pointer conflict, and exact-file comparison. Keep existing `contentHash` semantics stable where callers depend on them; introduce an explicit publication hash instead of silently redefining it.
2. Add GitHub detail, authenticated-account, PATCH, and revision-read adapters; retain the current per-file size limits and reject both file-level and top-level truncated Gist responses. Extend typed RPCs for link preview/commit, publication preview/commit, status, and unresolved-operation reconciliation. Keep the existing ad-hoc multi-pack `gist.create` unlinked.
3. Add the Gist section and review sheets. Cover host-only, repository sidecar, and portable YAML choices; owner mismatch; local/remote/both-changed states; multi-file Gists; and narrow and wide layouts in both themes.
4. Fault-test a PATCH that succeeds before the response is lost, POST creation before local link save, the second portable-YAML PATCH failing, a remote edit between check and write, and a sidecar changed by another clone. A normal publish changes only the bound file and never Paseo's live `agentProfiles`.

The first release can defer an embedded remote-history browser, a cross-location Move wizard, replacing a different pack's Gist file, and automatic recovery of ambiguous create results. The three link-location choices, active-link switch on new publication, and uncertain-result handling are part of the core flow.
