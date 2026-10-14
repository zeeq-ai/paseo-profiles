Manage a separate library of named Paseo agent profile packs. Save one or more current agent profiles, exchange YAML files, and review updates from someone else's pack before replacing your saved copy or importing it separately.

The library supports renaming, duplication, previous versions, and importing selected profiles into Paseo. Use pack replaces the current host's complete profile list after a preview and recovery snapshot. Existing agents keep their settings.

Requires Paseo 0.11.2 or later on the daemon and app. The library is stored on the daemon host, separately from the plugin installation. Its folder can be changed in the plugin settings. Library files and recovery data remain after plugin removal.

Browser clients can select files and download YAML. All clients can import and export host files or use copy and paste. Host paths refer to the selected daemon's machine.

The plugin reads the host's saved agent profiles and writes the profile list only after an explicit Add or Use action. It makes no external network requests. Profile changes use Paseo's configuration API; simultaneous changes from another client can still race because that API has no conditional write.

The library expects a local filesystem. Interrupted batches report partial completion; a crash can leave a lock that requires checking its recorded owner before removal.
