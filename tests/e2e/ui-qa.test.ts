import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { describe, it } from "vitest";
import { serializeSet } from "../../server/yaml";
import { saveSet } from "../../shared/rpc";
import { profile, profileSet } from "../fixtures/profile-sets";
import { startDaemonWithFakeGitHub } from "./support/fake-gh-daemon";
import { callPluginRpc } from "./support/plugin-rpc";

// Not a regression test. With PASEO_PROFILES_UI_QA=<info.json path> it starts an isolated daemon
// (temporary home, ephemeral port, relay off, web UI served) whose `gh` is the stateful fake,
// seeds a saved pack and two Gists, writes connection details to <info.json>, and stays up until
// <info.json>.stop exists (or 40 minutes pass). Needs PASEO_PROFILES_WEB_UI_DIST_DIR for the UI.
//
//   PASEO_PROFILES_UI_QA=/tmp/gist-qa.json PASEO_PROFILES_CLI_VERSION=0.13.2 \
//   PASEO_PROFILES_WEB_UI_DIST_DIR=/Applications/Paseo.app/Contents/Resources/app-dist \
//   npx vitest run --config tests/vitest.e2e.config.ts tests/e2e/ui-qa.test.ts
const infoFile = process.env.PASEO_PROFILES_UI_QA;

describe.skipIf(!infoFile)("isolated daemon for manual UI QA", () => {
  it("serves the plugin with a fake GitHub until stopped", { timeout: 41 * 60_000 }, async () => {
    if (!infoFile) return;
    const env = await startDaemonWithFakeGitHub({ id: 1001, login: "charles" });
    try {
      const pack = profileSet({
        id: "2dbfbd3d-81eb-4ab2-90a4-45dd2ef67e2b",
        name: "Fast review",
        profiles: [
          profile({ id: "reviewer", name: "Reviewer", model: "gpt-6-sol" }),
          profile({ id: "tester", name: "Tester" }),
        ],
        appendSystemPrompt: "Review carefully.\n",
      });
      const saved = await callPluginRpc(env.daemon, saveSet, { libraryRoot: "", set: pack });
      const own = await env.gh.seed({
        id: "3f9ac21e3f9ac21e3f9ac21e3f9ac21e",
        description: "Paseo agent profile packs",
        files: { "fast-review.yaml": serializeSet(pack), "notes.md": "unrelated\n" },
      });
      const jamie = await env.gh.seed({
        id: "9b8a7c6d9b8a7c6d9b8a7c6d9b8a7c6d",
        owner: { id: 2002, login: "jamie" },
        files: { "fast-review.yaml": serializeSet(pack) },
      });
      await writeFile(
        infoFile,
        `${JSON.stringify(
          {
            baseUrl: env.daemon.baseUrl,
            webUiEnabled: env.daemon.webUiEnabled,
            home: env.daemon.home,
            savedLocalId: saved.localId,
            savedRevision: saved.revision,
            ownGistId: own.id,
            jamieGistId: jamie.id,
            fakeGhStateFile: env.gh.stateFile,
            fakeGhBinDir: env.gh.binDir,
          },
          null,
          2,
        )}\n`,
      );
      const deadline = Date.now() + 40 * 60_000;
      while (!existsSync(`${infoFile}.stop`) && Date.now() < deadline) await delay(500);
    } finally {
      await env.close();
    }
  });
});
