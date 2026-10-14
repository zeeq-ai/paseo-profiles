import { canonicalJson, profilesDiff } from "./canonical";
import type { ProfileSet } from "./set";

export function describeImport(
  current: ProfileSet | undefined,
  incoming: ProfileSet,
  baseline?: ProfileSet,
) {
  const sourceUnchanged = !!baseline && canonicalJson(incoming) === canonicalJson(baseline);
  const localChanges =
    !!current && !!baseline && canonicalJson(current) !== canonicalJson(baseline);
  const diff = profilesDiff(current?.profiles ?? [], incoming.profiles);
  return {
    diff,
    localChanges,
    sourceUnchanged,
    locallyEdited:
      baseline && current
        ? profilesDiff(baseline.profiles, current.profiles)
        : profilesDiff([], []),
    message:
      sourceUnchanged && localChanges
        ? "Source unchanged; local changes retained"
        : sourceUnchanged
          ? "Source unchanged"
          : current && canonicalJson(current) === canonicalJson(incoming)
            ? "Contents already match; update import baseline only"
            : localChanges
              ? "Review local changes before replacing"
              : "Ready to import",
  };
}
