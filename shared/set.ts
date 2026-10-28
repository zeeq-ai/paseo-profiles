import { z } from "zod";

export const LIMITS = { bytes: 512_000, files: 16, profiles: 500, depth: 32 } as const;
export const JsonValueSchema = z.json();
export const ProfileSchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    // An empty provider asks the destination to choose from its configured providers.
    provider: z.string().default(""),
    icon: z.string().optional(),
    color: z.string().optional(),
    model: z.string().optional(),
    modeId: z.string().optional(),
    thinkingOptionId: z.string().optional(),
    featureValues: z.record(z.string(), JsonValueSchema).optional(),
    notes: z.string().optional(),
  })
  .catchall(JsonValueSchema);
export const ProfilesSchema = z
  .array(ProfileSchema)
  .max(LIMITS.profiles)
  .superRefine((profiles, ctx) => {
    const ids = new Set<string>();
    for (const [index, profile] of profiles.entries()) {
      if (ids.has(profile.id))
        ctx.addIssue({ code: "custom", path: [index, "id"], message: "Duplicate profile ID" });
      ids.add(profile.id);
    }
  });
export function isSafeGistFileName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= 255 &&
    name !== "." &&
    name !== ".." &&
    !name.includes("/") &&
    !name.includes("\\") &&
    Array.from(name).every((character) => {
      const code = character.charCodeAt(0);
      return code >= 32 && code !== 127;
    })
  );
}
// A portable destination pointer. It names a Gist and file; it never claims authority or a revision.
export const GistPointerFieldSchema = z
  .object({
    id: z.string().regex(/^[a-fA-F0-9]{5,64}$/, "Expected a Gist ID"),
    file: z
      .string()
      .min(1)
      .max(255)
      .refine((name) => isSafeGistFileName(name), { message: "Unsupported Gist file name" }),
  })
  .strict();
export type GistPointerField = z.infer<typeof GistPointerFieldSchema>;
// Version 1 stays byte-stable. Version 2 only adds the optional `gist` pointer, so older strict
// readers reject a pack that carries one instead of silently dropping it.
export const SetSchema = z
  .object({
    format: z.literal("paseo-profile-set"),
    version: z.union([z.literal(1), z.literal(2)]),
    id: z.string().min(1),
    name: z.string().trim().min(1),
    origin: z.object({ fingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/) }).optional(),
    copiedFrom: z.string().optional(),
    gist: GistPointerFieldSchema.optional(),
    appendSystemPrompt: z.string().optional(),
    profiles: ProfilesSchema.refine((p) => p.length > 0, "A saved pack needs at least one profile"),
  })
  .strict()
  .superRefine((set, ctx) => {
    if (set.gist && set.version !== 2)
      ctx.addIssue({
        code: "custom",
        path: ["gist"],
        message: "A Gist link requires version 2 of the profile-pack format",
      });
  });
export type Profile = z.infer<typeof ProfileSchema>;
export type ProfileSet = z.infer<typeof SetSchema>;
/** Returns the pack without its location-only Gist pointer, in the lowest version that holds it. */
export function withoutGist(set: ProfileSet): ProfileSet {
  const { gist: _gist, ...rest } = set;
  return { ...rest, version: 1 };
}
/** Returns the pack carrying a portable pointer (upgrading it to version 2). */
export function withGist(set: ProfileSet, gist: GistPointerField): ProfileSet {
  return { ...set, version: 2, gist };
}
/** Carries the target pack's lineage and update link onto incoming content (imports onto a target). */
export function adoptIdentity(incoming: ProfileSet, target: ProfileSet): ProfileSet {
  const base = { ...withoutGist(incoming), id: target.id };
  return target.gist ? withGist(base, target.gist) : base;
}
/** A new pack from existing content: new ID, lineage noted, and never the original's update link. */
export function asCopyOf(set: ProfileSet, id: string, copiedFrom?: string): ProfileSet {
  return { ...withoutGist(set), id, ...(copiedFrom ? { copiedFrom } : {}) };
}
/** The pack as profile content, ignoring the location-only link and the format version it implies. */
export const semanticSet = withoutGist;
export const EntrySchema = z.object({
  localId: z.string(),
  revision: z.string(),
  contentHash: z.string(),
  set: SetSchema,
});
export type LibraryEntry = z.infer<typeof EntrySchema>;
export const DiffSchema = z.object({
  added: z.array(z.string()),
  changed: z.array(z.string()),
  removed: z.array(z.string()),
  reordered: z.boolean(),
});
export const OriginSchema = z.object({ fingerprint: z.string() });
