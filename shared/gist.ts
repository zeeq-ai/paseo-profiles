import { z } from "zod";
import { DiffSchema, ProfilesSchema } from "./set";

/** Release that first reads and writes the portable `gist` field (profile-pack format version 2). */
export const PORTABLE_LINK_MIN_PLUGIN_VERSION = "0.2.0";

// Where the active pointer is stored. "portable" is the v2 YAML field.
export const GistStorageSchema = z.enum(["host", "repository", "portable"]);
export type GistStorage = z.infer<typeof GistStorageSchema>;

export const GistAccountSchema = z.object({ id: z.number(), login: z.string() });
export const GistPointerSchema = z.object({
  gistId: z.string().min(1),
  fileName: z.string().min(1),
});
export type GistPointer = z.infer<typeof GistPointerSchema>;

/** Repository sidecar at `<repo>/.paseo-profiles/gists/<sha256(packId)>.json`. */
export const GistSidecarSchema = z
  .object({
    format: z.literal("paseo-profile-gist-link"),
    version: z.literal(1),
    packId: z.string().min(1),
    gistId: z.string().regex(/^[a-fA-F0-9]{5,64}$/),
    fileName: z.string().min(1).max(255),
    lastConfirmedRevision: z.string().optional(),
    lastPublishedFileHash: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .optional(),
  })
  .strict();
export type GistSidecar = z.infer<typeof GistSidecarSchema>;

export const GistBaselineSchema = z.object({
  /** GitHub revision of the whole Gist when this baseline was recorded (may be unknown). */
  revision: z.string().optional(),
  /** `sha256:` of the exact file text last published or read for the bound file. */
  fileHash: z.string(),
  /** Hash of the pack content (profiles, prompt, name; not the location-only pointer). */
  contentHash: z.string(),
  recordedAt: z.string(),
  source: z.enum(["published", "linked", "refreshed"]),
});
export type GistBaseline = z.infer<typeof GistBaselineSchema>;

export const GistPreviousLinkSchema = z.object({
  gistId: z.string(),
  fileName: z.string(),
  url: z.string().optional(),
  ownerLogin: z.string().optional(),
  public: z.boolean().optional(),
  lastRevision: z.string().optional(),
  replacedAt: z.string(),
  reason: z.enum(["switched", "relinked", "unlinked"]),
});

export const GistVisibilitySchema = z.enum(["secret", "public"]);

/** Everything the UI needs to render one pack's Gist section. `state` is plain text first. */
export const GistStateSchema = z.enum([
  "unlinked",
  "link-conflict",
  "needs-confirmation",
  "unresolved-operation",
  "pending-first-publish",
  "unpublished-changes",
  "remote-changed",
  "both-changed",
  "link-change",
  "baseline-refresh",
  "up-to-date",
  "blocked",
  "check-github-account",
  /** GitHub could not be read (network, size, server error); nothing is verified. */
  "check-failed",
]);
export type GistState = z.infer<typeof GistStateSchema>;

export const GistBlockerSchema = z.object({
  code: z.enum([
    "file-missing",
    "pack-id-mismatch",
    "remote-invalid",
    "not-owner",
    "link-conflict",
    "identity-mismatch",
    "needs-confirmation",
    "unresolved-operation",
    "not-linked",
    "json-file",
    "repository",
    "gist-not-found",
  ]),
  message: z.string(),
});

export const GistLocationSchema = z.object({
  location: GistStorageSchema,
  pointer: GistPointerSchema.optional(),
  /** Host path of the record, or `pack` for the YAML field. */
  path: z.string().optional(),
  problem: z.string().optional(),
});

export const GistOperationStatusSchema = z.enum([
  "prepared",
  "sending",
  "created",
  "remote-confirmed",
  "complete",
  "failed",
  "unknown",
  "dismissed",
]);
export const GistOperationActionSchema = z.enum(["check", "finish", "adopt", "dismiss"]);

export const GistOperationSchema = z.object({
  id: z.string(),
  kind: z.enum(["revision", "new"]),
  status: GistOperationStatusSchema,
  /** Plain-language outcome headline, e.g. "Gist created; link embedding unfinished". */
  phase: z.enum([
    "in-progress",
    "not-sent",
    "outcome-unknown",
    "gist-created-link-unfinished",
    "published-local-save-pending",
    "complete",
    "rejected",
    "dismissed",
  ]),
  message: z.string(),
  error: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  localId: z.string(),
  packId: z.string(),
  gist: z
    .object({
      id: z.string().optional(),
      url: z.string().optional(),
      fileName: z.string(),
      public: z.boolean().optional(),
    })
    .optional(),
  revision: z.string().optional(),
  /** What the user may do next; `check` never writes to GitHub. */
  nextActions: z.array(GistOperationActionSchema),
  evidence: z
    .object({
      remoteFileHash: z.string().optional(),
      expectedFileHash: z.string(),
      remoteRevision: z.string().optional(),
      remoteUpdatedAt: z.string().optional(),
      matches: z.boolean(),
    })
    .optional(),
  /** Recent account Gists whose file and pack ID exactly match an unconfirmed create. */
  candidates: z.array(
    z.object({ gistId: z.string(), url: z.string(), updatedAt: z.string().optional() }),
  ),
});
export type GistOperation = z.infer<typeof GistOperationSchema>;

export const GistRemoteSchema = z.object({
  id: z.string(),
  url: z.string(),
  owner: GistAccountSchema,
  public: z.boolean(),
  revision: z.string().optional(),
  updatedAt: z.string().optional(),
  fileExists: z.boolean(),
  fileHash: z.string().optional(),
  otherFileCount: z.number(),
});

export const GistStatusSchema = z.object({
  localId: z.string(),
  packId: z.string(),
  state: GistStateSchema,
  /** Pointer in force. Absent when unlinked or when pointers conflict. */
  pointer: GistPointerSchema.optional(),
  url: z.string().optional(),
  storage: GistStorageSchema.optional(),
  repository: z.string().optional(),
  sidecarPath: z.string().optional(),
  /** Every location holding a pointer, so a conflict can be reviewed. */
  locations: z.array(GistLocationSchema),
  /** The pointer was reviewed and confirmed on this Paseo host. */
  confirmed: z.boolean(),
  pendingFirstPublish: z.boolean(),
  /** Pack content differs from the last published baseline (cached, no network). */
  localChanged: z.boolean(),
  baseline: GistBaselineSchema.optional(),
  blockers: z.array(GistBlockerSchema),
  previous: z.array(GistPreviousLinkSchema),
  operation: GistOperationSchema.optional(),
  /** Set when GitHub was consulted by this call. Cached calls report the last check. */
  checked: z.boolean(),
  lastCheckedAt: z.string().optional(),
  account: GistAccountSchema.optional(),
  ownership: z.enum(["owner", "not-owner", "unknown"]),
  remote: GistRemoteSchema.optional(),
  checkError: z
    .object({ kind: z.enum(["auth", "not-found", "other"]), message: z.string() })
    .optional(),
});
export type GistStatus = z.infer<typeof GistStatusSchema>;

export const GistFileInfoSchema = z.object({
  name: z.string(),
  bytes: z.number(),
  kind: z.enum(["yaml", "json", "other"]),
  /** Parsed pack facts for readable YAML/JSON packs. */
  packId: z.string().optional(),
  packName: z.string().optional(),
  profileCount: z.number().optional(),
  parseError: z.string().optional(),
  /** Same pack ID as the saved pack named in the request, when one was given. */
  matchesPack: z.boolean().optional(),
  /** This file can be selected for linking (YAML with the same pack ID). */
  linkable: z.boolean(),
});

export const GistInspectionSchema = z.object({
  gist: z.object({
    id: z.string(),
    url: z.string(),
    owner: GistAccountSchema,
    public: z.boolean(),
    revision: z.string().optional(),
    updatedAt: z.string().optional(),
  }),
  account: GistAccountSchema,
  ownership: z.enum(["owner", "not-owner"]),
  files: z.array(GistFileInfoSchema),
  /** Exactly one file with the saved pack's ID, else undefined. Never an ambiguous guess. */
  suggestedFile: z.string().optional(),
});

/** A before/target comparison the UI can feed to the existing profile diff review. */
export const GistComparisonSchema = z.object({
  before: ProfilesSchema,
  target: ProfilesSchema,
  diff: DiffSchema,
  nameChanged: z.object({ before: z.string(), target: z.string() }).optional(),
  systemPrompt: z.object({ before: z.string(), target: z.string() }).optional(),
});
export type GistComparison = z.infer<typeof GistComparisonSchema>;

export const GistLinkPreviewSchema = z.object({
  previewId: z.string(),
  gist: GistInspectionSchema.shape.gist,
  account: GistAccountSchema,
  ownership: z.enum(["owner", "not-owner"]),
  fileName: z.string(),
  fileExists: z.boolean(),
  /** A new YAML filename in a Gist this account owns; the first publish adds the file. */
  pendingFirstPublish: z.boolean(),
  /** Writing to this Gist is available to this host account. Link is allowed either way. */
  canPublish: z.boolean(),
  storage: GistStorageSchema,
  /** Exact host path that will be written; `undefined` for portable. */
  destination: z.string().optional(),
  repository: z.string().optional(),
  /** Portable choice upgrades the pack file to v2. */
  upgradesPackFormat: z.boolean(),
  minimumPluginVersion: z.string().optional(),
  /** Pointers that exist now and will be replaced or removed by this link. */
  replaces: z.array(GistLocationSchema),
  /** A sidecar already exists at the chosen destination with this pointer. */
  existingSidecar: GistPointerSchema.optional(),
  /** Remote file vs saved pack, when the remote file exists. */
  comparison: GistComparisonSchema.optional(),
  /** Saved pack equals the remote file exactly (up to date after linking). */
  identical: z.boolean(),
  visibility: GistVisibilitySchema,
  warnings: z.array(z.string()),
  blockers: z.array(GistBlockerSchema),
});

export const GistPublishActionSchema = z.enum([
  "publish",
  "overwrite",
  "replace-saved-pack",
  "publish-new",
  "review-updates",
  "refresh-baseline",
]);

export const GistPublishPreviewSchema = z.object({
  previewId: z.string(),
  mode: z.enum(["revision", "new"]),
  state: GistStateSchema,
  account: GistAccountSchema,
  ownership: z.enum(["owner", "not-owner", "unknown"]),
  /** Existing target for `revision`; the target to be created for `new`. */
  target: z.object({
    gistId: z.string().optional(),
    url: z.string().optional(),
    fileName: z.string(),
    ownerLogin: z.string().optional(),
    public: z.boolean(),
    description: z.string().optional(),
  }),
  storage: GistStorageSchema,
  repository: z.string().optional(),
  destination: z.string().optional(),
  /** Other files in the Gist that stay unchanged. */
  otherFileCount: z.number(),
  /** Actions that may be committed now. */
  actions: z.array(GistPublishActionSchema),
  /** The default (primary) action, if any. */
  primaryAction: GistPublishActionSchema.optional(),
  hashes: z.object({
    payload: z.string(),
    remote: z.string().optional(),
    baseline: z.string().optional(),
  }),
  remoteChanged: z.boolean(),
  localChanged: z.boolean(),
  /** Only the portable pointer differs ("Link change to publish"). */
  linkChange: z.boolean(),
  alreadyEqual: z.boolean(),
  /** Commit must pass `overwriteRemote: true`. */
  requiresOverwrite: z.boolean(),
  /** Commit must pass `confirmTarget: true` (pointer not yet confirmed on this host). */
  requiresTargetConfirmation: z.boolean(),
  /** Pack content that will be written (remote -> saved pack). */
  replace: GistComparisonSchema.optional(),
  /** What changed locally since the last baseline. */
  localChange: GistComparisonSchema.optional(),
  /** What changed on GitHub since the last baseline. */
  remoteChange: GistComparisonSchema.optional(),
  upgradesPackFormat: z.boolean(),
  minimumPluginVersion: z.string().optional(),
  /** `new` + portable: POST then PATCH; two remote steps. */
  twoStep: z.boolean(),
  warnings: z.array(z.string()),
  blockers: z.array(GistBlockerSchema),
  expiresAt: z.string(),
});
export type GistPublishPreview = z.infer<typeof GistPublishPreviewSchema>;

export const GistPublishOutcomeSchema = z.enum([
  "published",
  "already-up-to-date",
  "remote-changed",
  "partial-local-save",
  "link-embedding-unfinished",
  "outcome-unknown",
  "rejected",
]);
export type GistPublishOutcome = z.infer<typeof GistPublishOutcomeSchema>;

/** Host-local link state: `$state/gist-links/<localId>.json`. Never leaves the host. */
export const HostLinkRecordSchema = z.object({
  format: z.literal("paseo-profile-gist-host-link"),
  version: z.literal(1),
  localId: z.string(),
  packId: z.string(),
  storage: GistStorageSchema,
  /** Git worktree root whose sidecar holds the pointer (storage "repository"). */
  repository: z.string().optional(),
  /** The pointer itself when storage is "host". */
  pointer: GistPointerSchema.optional(),
  pendingFirstPublish: z.boolean().optional(),
  /** The pointer and owner a person reviewed and confirmed on this host. */
  trusted: z
    .object({
      gistId: z.string(),
      fileName: z.string(),
      ownerId: z.number().optional(),
      ownerLogin: z.string().optional(),
      confirmedAt: z.string(),
    })
    .optional(),
  baseline: GistBaselineSchema.optional(),
  previous: z.array(GistPreviousLinkSchema),
  lastCheckedAt: z.string().optional(),
  /** Display facts from the last GitHub contact. */
  lastKnown: z
    .object({
      url: z.string().optional(),
      ownerId: z.number().optional(),
      ownerLogin: z.string().optional(),
      public: z.boolean().optional(),
    })
    .optional(),
});
export type HostLinkRecord = z.infer<typeof HostLinkRecordSchema>;

export const gistKey = (pointer: GistPointer) =>
  `${pointer.gistId.toLowerCase()}/${pointer.fileName}`;
