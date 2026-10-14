# Paseo profile packs

A Paseo plugin for a separate library of agent profile packs. Save profiles from a connected host, exchange YAML files, update imported packs, and apply a chosen pack to Paseo.

## Install

Requires Paseo 0.11.2 or later on the daemon and app, with plugins enabled on the target host.

```sh
paseo plugin install https://github.com/zeeq-ai/paseo-profiles.git
```

Open **Agent profile packs** from the sidebar or Command Center. Configure **Library folder** in the plugin's settings.

## Use the library

- **Save selected as pack** captures one or more current agent profiles without changing Paseo.
- **Import packs** brings YAML files into the library. Raw Paseo JSON configuration can also supply agent profiles.
- **Export** produces portable YAML for selected current profiles or saved packs.
- **Add selected to Paseo** adds profiles or replaces explicit targets, preserving unrelated profiles.
- **Use pack** previews and replaces the host's complete current profile list.

The default library is `$PASEO_HOME/plugin-data/paseo-profiles/sets`. Changing folders opens another library without moving files or applying profiles. Library files and host-local history/recovery data survive plugin removal. A custom folder preference must be selected again after reinstalling.

Browser clients can choose files and download YAML. All clients support host-file paths and copy/paste. A host path refers to the selected daemon's filesystem; native device file dialogs are not provided by the current plugin SDK.

## Update a shared pack

Export an existing saved pack to retain its stable identity. When Jamie sends a later export, import it and review additions, changes, removals, and any local edits. **Update existing pack** replaces the saved entry; **Import incoming as a new pack** preserves both copies. The previous version remains in history.

Exports of saved packs retain a stable pack ID. A fresh export from current profiles creates a new identity. Original captures also include an origin fingerprint derived from the persistent daemon ID and source path. Content hashes identify revisions. A subset or separate copy gets a new pack ID while retaining provenance, so sharing partial selections does not silently replace the original pack.

Library updates do not change Paseo. **Update and use** reviews both changes before replacing the complete current profile list. To preserve unrelated current profiles, update the saved pack and then add or replace selected profiles. History restores saved library versions; recovery restores previous Paseo profile lists through a separate preview.

Paseo's configuration API has no conditional write. The plugin checks for observed changes, serializes its own operations, and saves recovery state before applying, but another Paseo client can still edit the list between the final check and write. Existing agents retain their settings.

See [example packs](examples/) for the portable format (`format: paseo-profile-set`, `version: 1`). Notes and all JSON-compatible profile fields are preserved, including fields the plugin does not recognize. Exports omit unrelated daemon configuration.

## Develop

```sh
npm ci --ignore-scripts
npm run typecheck
npm run lint
npm test
npm run test:e2e
npm pack --dry-run
```

The E2E harness uses an isolated temporary daemon home and port. It requires `paseo` 0.11.2 on PATH. Source changes load with `paseo plugin reload paseo-profiles` on the target development daemon. Use `--home <path>` when selecting an isolated daemon.

Use a local filesystem for the library. Interrupted writes reconcile on the next library operation. A killed process can leave a lock directory; the error identifies its `owner.json`. Verify that the recorded owner has stopped before removing that lock. Batch imports publish packs in sequence and report any partial completion.

## Design and ownership

- [Implementation plan](docs/plan.md)
- [Research and source references](docs/research.md)
- [Team and ownership](docs/team.md)
- [Verification and limits](docs/verification.md)
