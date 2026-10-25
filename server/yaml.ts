import { isAlias, isMap, isScalar, isSeq, parseDocument, stringify } from "yaml";
import { LIMITS, type ProfileSet, SetSchema } from "../shared/set";

export function parseSet(
  text: string,
  name = "Imported profiles",
): { set: ProfileSet; hasIdentity: boolean } {
  if (Buffer.byteLength(text, "utf8") > LIMITS.bytes)
    throw new Error("File exceeds the import size limit");
  const doc = parseDocument(text, {
    version: "1.2",
    schema: "core",
    uniqueKeys: true,
    strict: true,
  });
  if (doc.errors.length) throw new Error(doc.errors.map((e) => e.message).join("; "));
  function inspect(node: unknown, depth: number): void {
    if (depth > LIMITS.depth) throw new Error("Document is too deeply nested");
    if (!node || typeof node !== "object") return;
    if (isAlias(node)) throw new Error("YAML aliases are not supported");
    const tagged = node as { tag?: string };
    if (tagged.tag) throw new Error("Explicit YAML tags are not supported");
    if (isMap(node))
      for (const pair of node.items) {
        if (!isScalar(pair.key) || typeof pair.key.value !== "string")
          throw new Error("Mapping keys must be strings");
        inspect(pair.value, depth + 1);
      }
    else if (isSeq(node)) for (const item of node.items) inspect(item, depth + 1);
    else if (isScalar(node) && typeof node.value === "number" && !Number.isFinite(node.value))
      throw new Error("Nonfinite numbers are not supported");
  }
  inspect(doc.contents, 0);
  const value: unknown = doc.toJS({ maxAliasCount: 0 });
  if (value && typeof value === "object" && "format" in value)
    return { set: SetSchema.parse(value), hasIdentity: true };
  // Project only portable profile settings from persisted or mutable daemon configuration.
  const raw = value as {
    daemon?: { agentProfiles?: unknown; appendSystemPrompt?: unknown };
    agentProfiles?: unknown;
    appendSystemPrompt?: unknown;
  } | null;
  const source = raw?.daemon?.agentProfiles !== undefined ? raw.daemon : raw;
  const profiles = source?.agentProfiles;
  if (!profiles)
    throw new Error(
      "Expected a profile-pack document or Paseo configuration containing agentProfiles",
    );
  return {
    set: SetSchema.parse({
      format: "paseo-profile-set",
      version: 1,
      id: "legacy",
      name,
      profiles,
      ...(source?.appendSystemPrompt !== undefined
        ? { appendSystemPrompt: source.appendSystemPrompt }
        : {}),
    }),
    hasIdentity: false,
  };
}

export function serializeSet(set: ProfileSet): string {
  return stringify(SetSchema.parse(set), {
    version: "1.2",
    schema: "core",
    aliasDuplicateObjects: false,
    lineWidth: 100,
  });
}
