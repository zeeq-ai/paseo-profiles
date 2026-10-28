import { afterEach, describe, expect, it, vi } from "vitest";
import { serializeSet } from "../../server/yaml";
import type { ProfileSet } from "../../shared/set";
import { profile, profileSet } from "../fixtures/profile-sets";
import {
  createPublicationFixture,
  type PublicationFixture,
  scenario,
} from "../support/publication";

const fixtures: PublicationFixture[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.dispose()));
});
async function setup(options: Parameters<typeof createPublicationFixture>[0] = {}) {
  const f = await createPublicationFixture(options);
  fixtures.push(f);
  return { f, s: scenario(f) };
}

const FILE = "fast-review.yaml";
const pack = (overrides: Partial<ProfileSet> = {}) =>
  profileSet({
    id: "pack-a",
    name: "Fast review",
    profiles: [profile({ id: "reviewer", name: "Reviewer", model: "m1" })],
    ...overrides,
  });

/** A linked, confirmed pack with one local edit ready to publish. */
async function readyToPublish(f: PublicationFixture, s: ReturnType<typeof scenario>) {
  const entry = await f.save(pack());
  const gist = await f.gh.seed({ files: { [FILE]: serializeSet(entry.set), "notes.md": "n\n" } });
  await s.link(entry.localId, { gistId: gist.id, fileName: FILE });
  const current = await f.store.read(entry.localId);
  const edited = await f.save(
    { ...current.set, name: "Fast review v2" },
    entry.localId,
    current.revision,
  );
  const preview = await s.previewRevision(entry.localId);
  return { entry: edited, gist, preview, text: serializeSet(edited.set) };
}

describe("a PATCH whose response is lost", () => {
  it("stays unknown, persists across a restart, never retries, and completes only on matching content", async () => {
    const { f, s } = await setup();
    const { entry, gist, preview, text } = await readyToPublish(f, s);
    await f.gh.fault({ match: "^PATCH /gists/", applied: true, effect: { kind: "error" } });
    await f.gh.clearRequests();

    const result = await s.commit(preview.previewId);

    expect(result.outcome).toBe("outcome-unknown");
    expect(result.operation?.phase).toBe("outcome-unknown");
    expect(result.operation?.nextActions).toEqual(["check", "dismiss"]);
    expect(result.status?.state).toBe("unresolved-operation");
    expect(await f.gh.writes()).toHaveLength(1);
    // The link has not been advanced on a guess.
    expect(result.status?.baseline?.fileHash).not.toBe(undefined);
    const operationId = preview.previewId;

    // A plugin restart sees the same unresolved operation, and no new review can start.
    const restarted = scenario(f, () => f.restart());
    expect((await restarted.status(entry.localId)).operation?.id).toBe(operationId);
    await expect(restarted.previewRevision(entry.localId)).rejects.toThrow(/did not finish/);
    // Repeating the commit reconciles instead of sending again.
    expect((await restarted.commit(operationId)).outcome).toBe("outcome-unknown");
    expect(await f.gh.writes()).toHaveLength(1);

    const checked = await restarted.operation(operationId, "check");
    expect(checked.operation.status).toBe("complete");
    expect(checked.operation.evidence?.matches).toBe(true);
    expect(checked.status?.state).toBe("up-to-date");
    expect(await f.gh.writes()).toHaveLength(1);
    expect((await f.gh.gist(gist.id)).files[FILE]?.content).toBe(text);
  });

  it("different current content cannot prove the write failed, so it stays uncertain", async () => {
    const { f, s } = await setup();
    const { entry, gist, preview } = await readyToPublish(f, s);
    await f.gh.fault({ match: "^PATCH /gists/", applied: true, effect: { kind: "error" } });
    await s.commit(preview.previewId);
    // Someone else replaced the file after our (successful but unconfirmed) write.
    await f.gh.edit(gist.id, FILE, serializeSet(pack({ name: "Replaced by someone" })));

    const checked = await s.operation(preview.previewId, "check");

    expect(checked.operation.status).toBe("unknown");
    expect(checked.operation.evidence?.matches).toBe(false);
    expect(checked.operation.nextActions).toEqual(["check", "dismiss"]);
    expect(checked.status?.state).toBe("unresolved-operation");
    expect(await f.gh.writes()).toHaveLength(1);
    // Closing releases the pack without claiming either outcome.
    const closed = await s.operation(preview.previewId, "dismiss");
    expect(closed.operation.phase).toBe("dismissed");
    expect(["remote-changed", "both-changed"]).toContain(
      (await s.status(entry.localId, true)).state,
    );
  });

  it("a write that GitHub did not receive is also unknown until checked, with no completion", async () => {
    const { f, s } = await setup();
    const { gist, preview } = await readyToPublish(f, s);
    await f.gh.fault({ match: "^PATCH /gists/", applied: false, effect: { kind: "error" } });

    const result = await s.commit(preview.previewId);
    const checked = await s.operation(preview.previewId, "check");

    expect(result.outcome).toBe("outcome-unknown");
    expect(checked.operation.evidence?.matches).toBe(false);
    expect(checked.operation.status).toBe("unknown");
    expect((await f.gh.gist(gist.id)).history).toHaveLength(1);
  });

  it("a timeout after the request was sent is unknown; the Gist may still have changed", async () => {
    const { f, s } = await setup();
    const { gist, preview, text } = await readyToPublish(f, s);
    vi.stubEnv("PASEO_PROFILES_GH_TIMEOUT_MS", "800");
    await f.gh.fault({ match: "^PATCH /gists/", applied: true, effect: { kind: "hang" } });
    await f.gh.clearRequests();

    const result = await s.commit(preview.previewId);

    expect(result.outcome).toBe("outcome-unknown");
    expect(await f.gh.writes()).toHaveLength(1);
    const checked = await s.operation(preview.previewId, "check");
    expect(checked.operation.status).toBe("complete");
    expect((await f.gh.gist(gist.id)).files[FILE]?.content).toBe(text);
    expect(await f.gh.writes()).toHaveLength(1);
  });

  it("a lost response simulated after the gateway returned (fault stage) is the same unknown", async () => {
    const stage = { fail: true };
    const { f, s } = await setup({
      fault: (name) => {
        if (name === "gistAfterRemoteWrite" && stage.fail) throw new Error("connection dropped");
      },
    });
    const { gist, preview, text } = await readyToPublish(f, s);

    const result = await s.commit(preview.previewId);

    expect(result.outcome).toBe("outcome-unknown");
    expect((await f.gh.gist(gist.id)).files[FILE]?.content).toBe(text);
    stage.fail = false;
    expect((await s.operation(preview.previewId, "check")).operation.status).toBe("complete");
    expect(await f.gh.writes()).toHaveLength(1);
  });

  it("an authorization failure is a definite rejection that changes nothing", async () => {
    const { f, s } = await setup();
    const { entry, gist, preview } = await readyToPublish(f, s);
    await f.gh.fault({
      match: "^PATCH /gists/",
      effect: {
        kind: "error",
        status: 403,
        message: "Resource not accessible by personal access token",
      },
    });

    const result = await s.commit(preview.previewId);

    expect(result.outcome).toBe("rejected");
    expect(result.operation?.phase).toBe("rejected");
    expect((await f.gh.gist(gist.id)).history).toHaveLength(1);
    // Nothing is left unresolved, so the person can simply try again after fixing access.
    expect((await s.status(entry.localId)).state).not.toBe("unresolved-operation");
    expect((await s.previewRevision(entry.localId)).actions).toContain("publish");
  });

  it("a 5xx on PATCH is treated as unknown, not as a failure", async () => {
    const { f, s } = await setup();
    const { preview } = await readyToPublish(f, s);
    await f.gh.fault({
      match: "^PATCH /gists/",
      effect: { kind: "error", status: 502, message: "Bad Gateway" },
    });

    expect((await s.commit(preview.previewId)).outcome).toBe("outcome-unknown");
  });
});

describe("the service stops at defined points", () => {
  it("a failure before the journal is written sends nothing and leaves nothing unresolved", async () => {
    const { f, s } = await setup({
      fault: (stage) => {
        if (stage === "gistBeforeJournal") throw new Error("disk full");
      },
    });
    const { entry, preview } = await readyToPublish(f, s);
    await f.gh.clearRequests();

    await expect(s.commit(preview.previewId)).rejects.toThrow("disk full");

    expect(await f.gh.writes()).toEqual([]);
    expect((await s.status(entry.localId)).operation).toBeUndefined();
  });

  it("a crash after the journal but before the request sends nothing yet is reported as unresolved", async () => {
    const { f, s } = await setup({
      fault: (stage) => {
        if (stage === "gistAfterJournal") throw new Error("process killed");
      },
    });
    const { entry, preview } = await readyToPublish(f, s);
    await f.gh.clearRequests();

    await expect(s.commit(preview.previewId)).rejects.toThrow("process killed");

    expect(await f.gh.writes()).toEqual([]);
    const restarted = scenario(f, () => f.restart({ fault: () => {} }));
    const status = await restarted.status(entry.localId);
    expect(status.state).toBe("unresolved-operation");
    // Reconciliation can show the Gist does not contain the payload, and it can be closed.
    const checked = await restarted.operation(preview.previewId, "check");
    expect(checked.operation.evidence?.matches).toBe(false);
    expect((await restarted.operation(preview.previewId, "dismiss")).operation.phase).toBe(
      "dismissed",
    );
    expect(await f.gh.writes()).toEqual([]);
    expect((await restarted.status(entry.localId)).operation).toBeUndefined();
  });

  it("a local save failure after a confirmed write is recoverable without another remote write", async () => {
    const failure = { on: true };
    const { f, s } = await setup({
      fault: (stage) => {
        if (stage === "gistBeforeLocalLinkSave" && failure.on) throw new Error("local disk error");
      },
    });
    const { entry, gist, preview, text } = await readyToPublish(f, s);
    await f.gh.clearRequests();

    const result = await s.commit(preview.previewId);

    expect(result.outcome).toBe("partial-local-save");
    expect(result.operation?.nextActions).toEqual(["finish", "dismiss"]);
    expect((await f.gh.gist(gist.id)).files[FILE]?.content).toBe(text);
    expect((await s.status(entry.localId)).state).toBe("unresolved-operation");

    failure.on = false;
    const finished = await s.operation(preview.previewId, "finish");
    expect(finished.operation.status).toBe("complete");
    expect(finished.status?.state).toBe("up-to-date");
    expect(await f.gh.writes()).toHaveLength(1);
    // Finishing again is harmless.
    expect((await s.operation(preview.previewId, "finish")).operation.status).toBe("complete");
    expect(await f.gh.writes()).toHaveLength(1);
  });

  it("finishing after the pack was edited again records the published baseline, not the new edit", async () => {
    const failure = { on: true };
    const { f, s } = await setup({
      fault: (stage) => {
        if (stage === "gistBeforeLocalLinkSave" && failure.on) throw new Error("local disk error");
      },
    });
    const { entry, preview } = await readyToPublish(f, s);
    await s.commit(preview.previewId);
    failure.on = false;
    const after = await f.store.read(entry.localId);
    const later = await f.save(
      { ...after.set, name: "Edited after the publish" },
      entry.localId,
      after.revision,
    );

    await s.operation(preview.previewId, "finish");

    const status = await s.status(entry.localId);
    expect((await f.store.read(entry.localId)).set.name).toBe("Edited after the publish");
    expect((await f.store.read(entry.localId)).revision).toBe(later.revision);
    // The later edit is still unpublished work.
    expect(status.localChanged).toBe(true);
    expect(status.state).toBe("unpublished-changes");
  });

  it("finishing after the link was changed elsewhere does not overwrite the new link", async () => {
    const failure = { on: true };
    const { f, s } = await setup({
      fault: (stage) => {
        if (stage === "gistBeforeLocalLinkSave" && failure.on) throw new Error("local disk error");
      },
    });
    const { entry, gist, preview } = await readyToPublish(f, s);
    await s.commit(preview.previewId);
    failure.on = false;
    // The person unlinks and relinks a different Gist while the operation is unresolved.
    const other = await f.gh.seed({
      files: { [FILE]: serializeSet((await f.store.read(entry.localId)).set) },
    });
    await f.writeHostRecord({
      localId: entry.localId,
      packId: entry.set.id,
      pointer: { gistId: other.id, fileName: FILE },
      trusted: { gistId: other.id, fileName: FILE, confirmedAt: "2026-10-28T12:00:00.000Z" },
    });

    const attempt = await s.operation(preview.previewId, "finish").catch((error: Error) => error);

    const status = await s.status(entry.localId);
    expect(status.pointer?.gistId).not.toBe(undefined);
    // Whatever the service decides, it must not silently re-point the pack at the old Gist.
    if (!(attempt instanceof Error))
      expect(attempt.status?.pointer?.gistId).toBe(status.pointer?.gistId);
    expect(gist.id).not.toBe(other.id);
    expect(status.pointer?.gistId).toBe(other.id);
  });
});
