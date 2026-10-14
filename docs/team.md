# Paseo profile packs team

The team was created through Paseo using the configured profiles and their launch settings. Research, implementation, architecture review, behavioral verification, and the final client terminology/layout review are complete.

Workspace: `/Users/cchen/code/zeeq/paseo-profiles`, Paseo workspace `wks_d90cf73268a3d779`.

| Member | Launch configuration | Ownership for implementation | Existing agent |
| --- | --- | --- | --- |
| Lead Architect role, this session | Current coordinator session | Requirements, decisions, shared contract integration, manifests, documentation, final verification | Parent session |
| Principal Engineer | `codex/gpt-6.1-sol`, `auto-review`, thinking `medium` | Portable schemas, file store, import/update baseline, activation/recovery services; technical review | `c63afbe7-80c3-4a5f-ad7f-9ad39daa2ff7` |
| Staff Engineer II | `codex/gpt-6-luna`, `auto-review`, thinking `xhigh` | Native library/current screens, review flows, directory settings, browser adapters | `6a2467f1-7484-41c1-9826-381db3877e98` |
| End-User Customer Advocate | `codex/gpt-6-astra`, `full-access`, thinking `xhigh`, `plan_mode: true` | Advisory review of import/update/apply terminology, native components, compact layouts and usability; no coding | `9355192b-c937-496f-831d-3e2f24a470f8` |
| Senior Software Engineer in Test | `codex/gpt-6-luna`, `auto-review`, thinking `xhigh` | Lossless transfer, provenance/update, file conflict/recovery, isolated daemon and visible user journeys | `56925690-97d5-40ed-970d-883365cbf896` |

These are launch records, not a promise that the human's profile definitions will remain unchanged. Discover profiles again before creating replacement agents. Reuse existing agents for follow-ups.

## Coordination

The lead publishes the agreed shared contracts before parallel work. The Principal Engineer owns `server/` and shared data behavior; Staff Engineer II owns `client/`; SDET owns `tests/` and coordinates focused checks. The lead owns root entrypoints/manifests and integrates shared edits. No two agents write the same moving files. Keep the Paseo source checkout read-only.

At each phase, report changed files, actual checks, unresolved behavior, and the next dependency. Flag a missing SDK capability or contract change immediately. Use Paseo completion notifications and background follow-ups rather than polling. Advisory agents review concrete flows and stable candidates. Do not create additional agents without a task-specific need.

The scaffold and shared contracts were established before parallel implementation. Storage, native UI, and behavioral verification were coordinated through the lead, who integrated the final client fixes and ran the isolated daemon/browser checks. The main Paseo test suite and daemon on port 6767 were left alone.
