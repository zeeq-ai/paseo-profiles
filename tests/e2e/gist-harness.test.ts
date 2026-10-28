import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serializeSet } from "../../server/yaml";
import {
  createGist,
  gistAvailability,
  gistLinkCommit,
  gistLinkPreview,
  gistPublishCommit,
  gistPublishOperation,
  gistPublishPreview,
  gistStatus,
  readGist,
  readSet,
  saveSet,
} from "../../shared/rpc";
import { profileSet } from "../fixtures/profile-sets";
import { type DaemonWithFakeGitHub, startDaemonWithFakeGitHub } from "./support/fake-gh-daemon";
import { callPluginRpc } from "./support/plugin-rpc";

// Proves the isolated daemon's plugin reaches the fake `gh`, never real GitHub. Every later
// publication e2e depends on this wiring.
describe("isolated daemon with a fake GitHub CLI", () => {
  let env: DaemonWithFakeGitHub | undefined;
  beforeAll(async () => {
    env = await startDaemonWithFakeGitHub({ id: 1001, login: "charles" });
  }, 60_000);
  afterAll(async () => {
    await env?.close();
  }, 30_000);

  it("creates and reads a Gist through the plugin RPCs against the fake only", async () => {
    if (!env) throw new Error("The isolated daemon did not start");
    expect(await callPluginRpc(env.daemon, gistAvailability, {})).toEqual({ available: true });

    const { url } = await callPluginRpc(env.daemon, createGist, {
      files: [{ name: "one.yaml", text: "a: 1\n" }],
    });

    const state = await env.gh.state();
    const [created] = Object.values(state.gists);
    expect(Object.keys(state.gists)).toHaveLength(1);
    expect(url).toMatch(new RegExp(`^https://gist\\.github\\.com/(charles/)?${created?.id}$`));
    expect(created?.public).toBe(false);
    const read = await callPluginRpc(env.daemon, readGist, { url });
    expect(read.files).toEqual([{ name: "one.yaml", text: "a: 1\n" }]);
    expect((await env.gh.requests()).every((request) => request.hostname === "github.com")).toBe(
      true,
    );
  });

  it("links, publishes an exact-file revision, recovers a lost response, and switches to a new Gist", async () => {
    if (!env) throw new Error("The isolated daemon did not start");
    const saved = await callPluginRpc(env.daemon, saveSet, {
      libraryRoot: "",
      set: profileSet({ id: "gist-rpc-pack", name: "RPC pack" }),
    });
    const gist = await env.gh.seed({
      files: { "pack.yaml": serializeSet(saved.set), "notes.md": "keep me\n" },
    });
    const link = await callPluginRpc(env.daemon, gistLinkPreview, {
      libraryRoot: "",
      localId: saved.localId,
      expectedRevision: saved.revision,
      gistId: gist.id,
      fileName: "pack.yaml",
      storage: "host",
    });
    await callPluginRpc(env.daemon, gistLinkCommit, {
      libraryRoot: "",
      previewId: link.previewId,
      confirmTarget: true,
    });
    let edited = await callPluginRpc(env.daemon, saveSet, {
      libraryRoot: "",
      localId: saved.localId,
      expectedRevision: saved.revision,
      set: { ...saved.set, name: "Revision one" },
    });
    const review = await callPluginRpc(env.daemon, gistPublishPreview, {
      libraryRoot: "",
      localId: saved.localId,
      expectedRevision: edited.revision,
      mode: "revision",
    });
    expect(
      (
        await callPluginRpc(env.daemon, gistPublishCommit, {
          libraryRoot: "",
          previewId: review.previewId,
        })
      ).outcome,
    ).toBe("published");
    expect((await env.gh.gist(gist.id)).files["notes.md"]?.content).toBe("keep me\n");
    edited = await callPluginRpc(env.daemon, saveSet, {
      libraryRoot: "",
      localId: saved.localId,
      expectedRevision: edited.revision,
      set: { ...edited.set, name: "Revision two" },
    });
    const uncertain = await callPluginRpc(env.daemon, gistPublishPreview, {
      libraryRoot: "",
      localId: saved.localId,
      expectedRevision: edited.revision,
      mode: "revision",
    });
    await env.gh.fault({
      match: `^PATCH /gists/${gist.id}$`,
      applied: true,
      effect: { kind: "error" },
    });
    const result = await callPluginRpc(env.daemon, gistPublishCommit, {
      libraryRoot: "",
      previewId: uncertain.previewId,
    });
    expect(result.outcome).toBe("outcome-unknown");
    const count = (await env.gh.writes()).length;
    expect(
      (
        await callPluginRpc(env.daemon, gistPublishOperation, {
          libraryRoot: "",
          operationId: uncertain.previewId,
          action: "check",
        })
      ).operation.phase,
    ).toBe("complete");
    expect((await env.gh.writes()).length).toBe(count);
    const next = await callPluginRpc(env.daemon, gistPublishPreview, {
      libraryRoot: "",
      localId: saved.localId,
      expectedRevision: edited.revision,
      mode: "new",
      storage: "portable",
      fileName: "pack.yaml",
    });
    const switched = await callPluginRpc(env.daemon, gistPublishCommit, {
      libraryRoot: "",
      previewId: next.previewId,
    });
    expect(switched.outcome).toBe("published");
    expect(switched.status?.pointer?.gistId).not.toBe(gist.id);
    expect((await env.gh.gist(gist.id)).files["pack.yaml"]?.content).toBe(serializeSet(edited.set));
    expect(
      (await callPluginRpc(env.daemon, readSet, { libraryRoot: "", localId: saved.localId })).set
        .gist?.id,
    ).toBe(switched.gist?.id);
    expect(
      (
        await callPluginRpc(env.daemon, gistStatus, {
          libraryRoot: "",
          localIds: [saved.localId],
          check: true,
        })
      ).statuses[0]?.state,
    ).toBe("up-to-date");
  });
});
