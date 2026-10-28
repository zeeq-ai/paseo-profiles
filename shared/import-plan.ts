import { canonicalJson, profilesDiff } from "./canonical";
import { type ProfileSet, semanticSet } from "./set";

/** Equal profile content; the location-only Gist link and its format version are ignored. */
export const sameContent = (a: ProfileSet, b: ProfileSet) =>
  canonicalJson(semanticSet(a)) === canonicalJson(semanticSet(b));

export function describeImport(
  current: ProfileSet | undefined,
  incoming: ProfileSet,
  baseline?: ProfileSet,
) {
  const sourceUnchanged = !!baseline && sameContent(incoming, baseline);
  const localChanges = !!current && !!baseline && !sameContent(current, baseline);
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
          : current && sameContent(current, incoming)
            ? "Contents already match; update import baseline only"
            : localChanges
              ? "Review local changes before replacing"
              : "Ready to import",
  };
}
