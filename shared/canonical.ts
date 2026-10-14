import type { Profile } from "./set";

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map(
      (key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
    )
    .join(",")}}`;
}
export function profilesDiff(before: Profile[], after: Profile[]) {
  const a = new Map(before.map((p) => [p.id, p]));
  const b = new Map(after.map((p) => [p.id, p]));
  return {
    added: after.filter((p) => !a.has(p.id)).map((p) => p.id),
    changed: after
      .filter((p) => a.has(p.id) && canonicalJson(a.get(p.id)) !== canonicalJson(p))
      .map((p) => p.id),
    removed: before.filter((p) => !b.has(p.id)).map((p) => p.id),
    reordered:
      canonicalJson(before.filter((p) => b.has(p.id)).map((p) => p.id)) !==
      canonicalJson(after.filter((p) => a.has(p.id)).map((p) => p.id)),
  };
}
