Manage a separate library of named Paseo agent profile packs. Save one or more current agent profiles, exchange YAML files, and review updates from someone else's pack before replacing your saved copy or importing it separately.

The library supports renaming, duplication, previous versions, icon and color editing, and importing selected profiles into Paseo. Select all quickly selects each list. Missing provider/model settings resolve against the destination's available configuration during apply review.

Packs also carry the shared system prompt. Use pack includes it by default; Add selected includes it only when enabled. Use pack replaces the current host's complete profile list after a preview and recovery snapshot. Recovery preserves the previous shared prompt too. Profile catalog changes do not reconfigure existing agents; shared prompt changes take effect when sessions start or restart.

Requires Paseo 0.11.2 or later on the daemon and app. The library is stored on the daemon host, separately from the plugin installation. Its folder can be changed in the plugin settings. Library files and recovery data remain after plugin removal.

Browser clients can select files and download YAML. All clients can import and export host files or use copy and paste. Host paths refer to the selected daemon's machine. When GitHub CLI (`gh`) is installed and authenticated on that host, the plugin can create secret Gists and load YAML/JSON from a supplied Gist URL for review. GitHub secret Gists are unlisted, not access-controlled; anyone with the URL can view them. Only load Gists from sources you trust.

The plugin reads the host's saved agent profiles and shared prompt and writes them only after an explicit Add, Use, or recovery action. Gist transfers are optional and use the authenticated GitHub CLI on the selected daemon host; exported profile data is sent to GitHub only when you choose to create a Gist. Gist contents are loaded as data for preview and are not executed. Changes use Paseo's configuration API; simultaneous changes from another client can still race because that API has no conditional write.

The library expects a local filesystem. Interrupted batches report partial completion; a crash can leave a lock that requires checking its recorded owner before removal.
