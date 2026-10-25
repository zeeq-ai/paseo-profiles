import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { DiffSchema, EntrySchema, LIMITS, ProfilesSchema, SetSchema } from "./set";

const root = { libraryRoot: z.string().default("") };
const id = z.string().regex(/^[a-zA-Z0-9_-]+$/);
const file = z.object({ name: z.string(), text: z.string().max(LIMITS.bytes) });
const exported = z.object({ name: z.string(), text: z.string() });
const gistFile = z.object({
  name: z.string().min(1).max(255),
  text: z.string().max(LIMITS.bytes),
});
const gistFiles = z
  .array(gistFile)
  .min(1)
  .max(LIMITS.files)
  .superRefine((files, ctx) => {
    const names = new Set<string>();
    let totalCharacters = 0;
    for (const [index, item] of files.entries()) {
      if (names.has(item.name))
        ctx.addIssue({ code: "custom", path: [index, "name"], message: "Duplicate file name" });
      names.add(item.name);
      totalCharacters += item.text.length;
    }
    if (totalCharacters > LIMITS.bytes * LIMITS.files)
      ctx.addIssue({ code: "custom", message: "Gist contents exceed the transfer size limit" });
  });
const rpc = <I extends z.ZodType, O extends z.ZodType>(name: string, input: I, output: O) =>
  defineRpc({ name, input, output });
export const listLibrary = rpc(
  "library.list",
  z.object(root),
  z.object({
    libraryRoot: z.string(),
    entries: z.array(EntrySchema),
    errors: z.array(z.object({ name: z.string(), error: z.string() })),
  }),
);
export const readSet = rpc("library.read", z.object({ ...root, localId: id }), EntrySchema);
export const saveSet = rpc(
  "library.save",
  z.object({
    ...root,
    localId: id.optional(),
    expectedRevision: z.string().optional(),
    set: SetSchema,
  }),
  EntrySchema,
);
export const duplicateSet = rpc(
  "library.duplicate",
  z.object({ ...root, localId: id, expectedRevision: z.string(), name: z.string().min(1) }),
  EntrySchema,
);
export const deleteSet = rpc(
  "library.delete",
  z.object({ ...root, localId: id, expectedRevision: z.string() }),
  z.object({ deleted: z.literal(true) }),
);
export const currentProfiles = rpc(
  "profiles.current",
  z.object({}),
  z.object({
    profiles: ProfilesSchema,
    appendSystemPrompt: z.string(),
    revision: z.string(),
    origin: z.object({ fingerprint: z.string() }),
    warnings: z.array(z.string()),
  }),
);
export const captureCurrent = rpc(
  "profiles.capture",
  z.object({
    ...root,
    name: z.string().min(1),
    profileIds: z.array(z.string()).min(1),
    expectedCurrentRevision: z.string(),
    localId: id.optional(),
    expectedRevision: z.string().optional(),
  }),
  EntrySchema,
);
export const exportProfiles = rpc(
  "profiles.export",
  z.object({
    ...root,
    source: z.enum(["current", "library"]),
    localIds: z.array(id).optional(),
    profileIds: z.array(z.string()).optional(),
    name: z.string().optional(),
    expectedCurrentRevision: z.string().optional(),
  }),
  z.object({ files: z.array(exported) }),
);
export const gistAvailability = rpc(
  "gist.availability",
  z.object({}),
  z.object({ available: z.boolean(), message: z.string().optional() }),
);
export const createGist = rpc(
  "gist.create",
  z.object({ files: gistFiles }),
  z.object({ url: z.string().url() }),
);
export const readGist = rpc(
  "gist.read",
  z.object({ url: z.string().trim().min(1).max(500) }),
  z.object({ files: gistFiles }),
);
export const importPreview = rpc(
  "import.preview",
  z.object({
    ...root,
    files: z.array(file).min(1).max(LIMITS.files),
    targetLocalId: id.optional(),
    asCopy: z.boolean().default(false),
  }),
  z.object({
    previewId: z.string(),
    items: z.array(
      z.object({
        index: z.number(),
        fileName: z.string(),
        incoming: SetSchema,
        target: EntrySchema.optional(),
        candidates: z.array(
          z.object({ localId: z.string(), name: z.string(), reason: z.string() }),
        ),
        diff: DiffSchema,
        locallyEdited: DiffSchema,
        localChanges: z.boolean(),
        sourceUnchanged: z.boolean(),
        message: z.string(),
      }),
    ),
  }),
);
export const importCommit = rpc(
  "import.commit",
  z.object({
    ...root,
    previewId: z.string(),
    replaceLocalChanges: z.boolean().default(false),
    applyPreviewId: z.string().optional(),
  }),
  z.object({
    entries: z.array(EntrySchema),
    libraryUpdated: z.boolean(),
    applied: z.boolean(),
    operationId: z.string().optional(),
    applyError: z.string().optional(),
    libraryError: z.string().optional(),
  }),
);
const selection = z.object({
  profileId: z.string(),
  action: z.enum(["skip", "keep-both", "replace", "add"]),
  targetId: z.string().optional(),
});
export const applyPreview = rpc(
  "apply.preview",
  z.object({
    ...root,
    localId: id.optional(),
    importPreviewId: z.string().optional(),
    snapshotId: id.optional(),
    mode: z.enum(["use", "add", "restore"]),
    applySystemPrompt: z.boolean().optional(),
    selections: z.array(selection).optional(),
  }),
  z.object({
    previewId: z.string(),
    before: ProfilesSchema,
    target: ProfilesSchema,
    diff: DiffSchema,
    warnings: z.array(z.string()),
    sourceName: z.string(),
    systemPrompt: z.object({ before: z.string(), target: z.string() }).optional(),
  }),
);
export const applyCommit = rpc(
  "apply.commit",
  z.object({ ...root, previewId: z.string() }),
  z.object({ operationId: z.string(), profiles: ProfilesSchema }),
);
export const historyList = rpc(
  "history.list",
  z.object({ ...root, localId: id }),
  z.object({
    versions: z.array(z.object({ revision: z.string(), name: z.string(), createdAt: z.string() })),
  }),
);
export const restoreHistory = rpc(
  "history.restore",
  z.object({ ...root, localId: id, revision: id, expectedRevision: z.string() }),
  EntrySchema,
);
export const recoveryList = rpc(
  "recovery.list",
  z.object(root),
  z.object({
    operations: z.array(
      z.object({
        id: z.string(),
        createdAt: z.string(),
        status: z.string(),
        sourceName: z.string(),
        beforeHash: z.string(),
        targetHash: z.string(),
        error: z.string().optional(),
      }),
    ),
    snapshots: z.array(
      z.object({ id: z.string(), createdAt: z.string(), profileCount: z.number() }),
    ),
  }),
);
export const readHostFile = rpc("files.read", z.object({ path: z.string().min(1) }), file);
export const writeHostFile = rpc(
  "files.write",
  z.object({ path: z.string().min(1), text: z.string().max(LIMITS.bytes) }),
  z.object({ path: z.string() }),
);
