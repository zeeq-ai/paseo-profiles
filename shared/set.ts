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
export const SetSchema = z
  .object({
    format: z.literal("paseo-profile-set"),
    version: z.literal(1),
    id: z.string().min(1),
    name: z.string().trim().min(1),
    origin: z.object({ fingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/) }).optional(),
    copiedFrom: z.string().optional(),
    appendSystemPrompt: z.string().optional(),
    profiles: ProfilesSchema.refine((p) => p.length > 0, "A saved pack needs at least one profile"),
  })
  .strict();
export type Profile = z.infer<typeof ProfileSchema>;
export type ProfileSet = z.infer<typeof SetSchema>;
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
