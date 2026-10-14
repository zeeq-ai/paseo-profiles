# Profile packs verification

Verified against Paseo daemon, app assets, and plugin SDK 0.11.2 on macOS with Node 24. Tests and browser checks used temporary daemon homes and loopback ports. The normal daemon on port 6767 and the Paseo source checkout were unchanged.

## Automated checks

- Data/schema, comparison, and YAML boundary tests cover lossless selected profile records, order and optional omissions, unknown JSON fields, malformed documents, and configuration projection.
- Library and service tests cover Jamie updates, retained local edits, metadata-only imports, stale revisions, explicit ambiguous targets, partial batches, snapshots before configuration writes, and stale apply reviews.
- Recovery regressions cover interrupted metadata publication through the same cached service and prevention of old journal replay over newer provenance.
- Real-daemon RPC tests cover save/read/duplicate/history, revision conflicts, library-only import, selected addition preserving unrelated configuration, recovery snapshots, and observed stale-preview rejection.

The E2E harness installs this directory plugin into its own enabled daemon, uses a separate home and ephemeral port, and removes that temporary runtime afterward.

Final local gates passed: `npm run check` (typecheck, lint, 27 unit tests in 5 files), `npm run test:e2e` (3 RPC tests against an isolated daemon), and `npm pack --dry-run --json` (all runtime files included).

## Browser checks

The lead and Customer Advocate used a separate daemon containing disposable personal and engineering profiles. Import and current-profile capture left the live list unchanged. Selected-profile host-file export contained the chosen record, an origin fingerprint, and no unrelated daemon settings. Clipboard export resolved in the Paseo browser. A Chrome download completed and its saved YAML contained exactly the selected profile.

Importing a second engineering file matched the earlier pack by stable source ID. Its review named one addition, one removal, and the changed notes with before/after values. Saving changed the library only. **Use pack** replaced the live list after a complete diff, and **Restore previous profiles** returned the prior list from a recovery snapshot. **Add selected** required an explicit target for replacement, then preserved an unrelated profile while replacing that target and adding a second selected profile. Changing selections after preview cleared the confirmation until a new preview was prepared. The combined **Update and use** path reviewed both the library and complete live-list changes before committing both successfully.

A separate SDK client changed the live catalog; the screen updated from the daemon configuration event without manual refresh. Switching to an empty custom library folder showed zero saved packs while keeping current profiles; switching back reopened the two saved packs. Disabling, removing, and reinstalling the plugin in the disposable daemon preserved both YAML files byte-for-byte and reopened them. The unrelated `appendSystemPrompt` setting remained intact after live profile operations.

Installation from the public Git URL at commit `ce5640e` also completed, started the plugin, and reopened the saved packs. This exercises the manifest's checkout preparation command with a clean install.

Wide (1203px) and compact (390px) screens were inspected in light and dark themes, including the import sheet and reviewed changes. The final client bundle loaded without plugin errors; the browser console contained only Paseo web/animation capability notices. The final restore button reads **Restore**.

## Limits of the evidence

No iOS or Android device has been tested. Those clients use React Native controls, host-file paths, and clipboard transfer; device file dialogs are browser-only adapters. Linux runtime checks run through CI; Windows has not been exercised.

Observed stale-state rejection does not prove exclusion of simultaneous external writers. Paseo has no conditional configuration write. Library locks are advisory and intended for local filesystems; killed-process locks require inspection of their recorded owner. Batch imports are recoverable sequential writes, not a multi-file transaction.
