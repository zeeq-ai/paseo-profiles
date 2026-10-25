# Paseo profile packs

A Paseo plugin for a separate library of agent profile packs. Save profiles from a connected host, exchange YAML files, update imported packs, and apply a chosen pack to Paseo.

## Install

Requires Paseo 0.11.2 or later on the daemon and app, with plugins enabled on the target host.

```sh
paseo plugin install https://github.com/zeeq-ai/paseo-profiles.git
```

Open **Agent profile packs** from the sidebar or Command Center. Configure **Library folder** in the plugin's settings.

## Use the library

- **Save selected as pack** captures one or more current agent profiles and the shared system prompt without changing Paseo.
- **Import packs** brings YAML files into the library. Raw Paseo JSON configuration can also supply agent profiles.
- **Export** produces portable YAML for selected current profiles or saved packs.
- **Create secret Gist** sends the selected export to GitHub using the authenticated `gh` CLI on the daemon host. A secret Gist is unlisted, not access-controlled; anyone with its URL can view it.
- **Import from Gist** loads YAML/JSON files from a trusted Gist URL into the normal preview flow. The plugin does not execute Gist contents.
- **Add selected to Paseo** adds profiles or replaces explicit targets, preserving unrelated profiles.
- **Use pack** previews and replaces the host's complete current profile list.

Use **Select all** or **Clear selection** in the current profiles, capture, Add profiles, and library lists. Open a saved pack and edit a profile's appearance to configure its icon and color; these edits stay in the library until you apply the pack.

Missing model, color, or icon values do not block import. Packs can omit the provider too. When applying, the plugin retains an available provider/model, otherwise prefers the target host's current profile settings and then a ready provider's selectable default model. Fallbacks appear in the preview. If discovery is unavailable or no provider is ready, the pack still imports and its values are preserved with a warning. Clients use their default appearance for unsupported icon/color values while preserving the original values for sharing.

Packs can include `appendSystemPrompt`, the host's shared system prompt. **Use pack** includes it by default; **Add selected** preserves the host's prompt unless you enable the shared-prompt switch. Review shows the current and incoming prompt. An omitted prompt preserves the host value; an explicitly empty prompt clears it when selected. The shared prompt affects agents on this host when sessions start or restart. Recovery snapshots preserve both profiles and the shared prompt.

The default library is `$PASEO_HOME/plugin-data/paseo-profiles/sets`. Changing folders opens another library without moving files or applying profiles. Library files and host-local history/recovery data survive plugin removal. A custom folder preference must be selected again after reinstalling.

Browser clients can choose files and download YAML. All clients support host-file paths and copy/paste. Gist transfer requires `gh` installed and authenticated for GitHub.com on the selected daemon host. Gist contents are not applied until you review and confirm them. A host path refers to the selected daemon's filesystem; native device file dialogs are not provided by the current plugin SDK.

## Update a shared pack

Export an existing saved pack to retain its stable identity. When Jamie sends a later export, import it and review additions, changes, removals, and any local edits. **Update existing pack** replaces the saved entry; **Import incoming as a new pack** preserves both copies. The previous version remains in history.

Exports of saved packs retain a stable pack ID. A fresh export from current profiles creates a new identity. Original captures also include an origin fingerprint derived from the persistent daemon ID and source path. Content hashes identify revisions. A subset or separate copy gets a new pack ID while retaining provenance, so sharing partial selections does not silently replace the original pack.

Library updates do not change Paseo. **Update and use** reviews both changes before replacing the complete current profile list. To preserve unrelated current profiles, update the saved pack and then add or replace selected profiles. History restores saved library versions; recovery restores previous Paseo profile lists through a separate preview.

Paseo's configuration API has no conditional write. The plugin checks for observed profile and prompt changes, serializes its own operations, and saves recovery state before applying, but another Paseo client can still edit the configuration between the final check and write. Profile catalog changes do not reconfigure existing agents.

See [example packs](examples/) for the portable format (`format: paseo-profile-set`, `version: 1`). Notes, icon, color, and all JSON-compatible profile fields are preserved, including fields the plugin does not recognize. Exports include the shared prompt and omit unrelated daemon configuration.

## Develop

```sh
npm ci --ignore-scripts
npm run typecheck
npm run lint
npm test
npm run test:e2e
npm pack --dry-run
```

The E2E harness uses an isolated temporary daemon home and port. It defaults to `paseo` 0.11.2 on PATH; set `PASEO_PROFILES_CLI_VERSION` to explicitly test a different installed version (for example, `PASEO_PROFILES_CLI_VERSION=0.13.0 npm run test:e2e`). Source changes load with `paseo plugin reload paseo-profiles` on the target development daemon. Use `--home <path>` when selecting an isolated daemon.

Use a local filesystem for the library. Interrupted writes reconcile on the next library operation. A killed process can leave a lock directory; the error identifies its `owner.json`. Verify that the recorded owner has stopped before removing that lock. Batch imports publish packs in sequence and report any partial completion.

## Design and ownership

- [Implementation plan](docs/plan.md)
- [Research and source references](docs/research.md)
- [Team and ownership](docs/team.md)
- [Verification and limits](docs/verification.md)
