import type { Profile, ProfileSet } from "../../shared/set";

export function profile(overrides: Partial<Profile> & Pick<Profile, "id" | "name">): Profile {
  return {
    provider: "codex",
    ...overrides,
  };
}

export function profileSet(overrides: Partial<ProfileSet> = {}): ProfileSet {
  return {
    format: "paseo-profile-set",
    version: 1,
    id: "jamie-engineering-set",
    name: "Jamie Engineering",
    origin: { fingerprint: `sha256:${"a".repeat(64)}` },
    profiles: [profile({ id: "engineering-review", name: "Engineering review" })],
    ...overrides,
  };
}
