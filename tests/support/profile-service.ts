import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Fault } from "../../server/files";
import { type PaseoAdapter, ProfileService } from "../../server/profile-service";
import type { Profile } from "../../shared/set";

export interface ServiceFixture {
  home: string;
  service: ProfileService;
  config: { agentProfiles: Profile[]; appendSystemPrompt: string };
  patches: Record<string, unknown>[];
  dispose(): Promise<void>;
}

/** A ProfileService over a temp Paseo home and an in-memory daemon configuration. */
export async function createServiceFixture(
  options: { profiles?: Profile[]; fault?: Fault; extra?: Record<string, unknown> } = {},
): Promise<ServiceFixture> {
  const home = await mkdtemp(path.join(tmpdir(), "paseo-profiles-gist-service-"));
  await writeFile(path.join(home, "server-id"), "paseo-profiles-gist-test\n", { flag: "wx" });
  const state = {
    config: {
      agentProfiles: options.profiles ?? [],
      appendSystemPrompt: "keep this daemon setting",
      pluginsEnabled: true,
    } as Record<string, unknown>,
    patches: [] as Record<string, unknown>[],
  };
  const adapter = {
    config: {
      get: async () => ({ config: state.config }),
      patch: async (patch: unknown) => {
        state.patches.push(patch as Record<string, unknown>);
        state.config = { ...state.config, ...(patch as Record<string, unknown>) };
        return { config: state.config };
      },
    },
  } as unknown as PaseoAdapter;
  const service = new ProfileService({
    home,
    paseo: adapter,
    fault: options.fault,
    ...(options.extra ?? {}),
  } as ConstructorParameters<typeof ProfileService>[0]);
  return {
    home,
    service,
    get config() {
      return state.config as ServiceFixture["config"];
    },
    patches: state.patches,
    dispose: () => rm(home, { recursive: true, force: true }),
  };
}
