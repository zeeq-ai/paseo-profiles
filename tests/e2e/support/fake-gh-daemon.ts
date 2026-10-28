import { createFakeGh, type FakeGh } from "../../support/fake-gh";
import type { FakeUser } from "../../support/fake-github";
import { type IsolatedDaemon, startIsolatedDaemon } from "./isolated-daemon";

export interface DaemonWithFakeGitHub {
  daemon: IsolatedDaemon;
  gh: FakeGh;
  close(): Promise<void>;
}

/**
 * An isolated daemon (temporary Paseo home, ephemeral port, relay off) whose `gh` is a stateful
 * fake. Nothing here can reach GitHub or the developer's `gh` configuration.
 */
export async function startDaemonWithFakeGitHub(
  user?: FakeUser,
  options: { env?: NodeJS.ProcessEnv } = {},
): Promise<DaemonWithFakeGitHub> {
  const gh = await createFakeGh(user);
  try {
    const daemon = await startIsolatedDaemon({ env: { ...gh.env, ...options.env } });
    return {
      daemon,
      gh,
      close: async () => {
        await daemon.close();
        await gh.dispose();
      },
    };
  } catch (error) {
    await gh.dispose();
    throw error;
  }
}
