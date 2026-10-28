import { randomUUID } from "node:crypto";
import type { PluginRpcContract, RpcInput, RpcOutput } from "@getpaseo/plugin";
import { profilesDiff } from "../shared/canonical";
import {
  type GistBaseline,
  type GistComparison,
  type GistOperation,
  type GistPointer,
  type GistState,
  type GistStatus,
  type GistStorage,
  gistKey,
  type HostLinkRecord,
  PORTABLE_LINK_MIN_PLUGIN_VERSION,
} from "../shared/gist";
import type * as contracts from "../shared/rpc";
import {
  isSafeGistFileName,
  type LibraryEntry,
  type ProfileSet,
  semanticSet,
  withGist,
  withoutGist,
} from "../shared/set";
import { errorText, type Fault, hash, rawHash } from "./files";
import { GistJournal, type PublishJournal, UNRESOLVED } from "./gist-journal";
import {
  GistLinkStore,
  readSidecar,
  removeSidecar,
  resolveRepository,
  sidecarPath,
  writeSidecar,
} from "./gist-link-store";
import {
  type GistAccount,
  type GistDocument,
  type GistGateway,
  ghGistGateway,
  gistIdFromUrl,
  isWriteOutcomeUnknown,
} from "./gists";
import type { LibraryStore } from "./library-store";
import { parseSet, serializeSet } from "./yaml";

type Blocker = GistStatus["blockers"][number];
type Location = GistStatus["locations"][number];
type Out<C extends PluginRpcContract> = RpcOutput<C>;

const PREVIEW_TTL_MS = 15 * 60_000;
const CANDIDATE_WINDOW_MS = 10 * 60_000;
const fileHash = (text: string) => `sha256:${rawHash(text)}`;
/** Pack content hash that ignores the location-only Gist pointer. */
export const publicationHash = (set: ProfileSet) => hash(semanticSet(set));
const pointerOf = (set: ProfileSet): GistPointer | undefined =>
  set.gist ? { gistId: set.gist.id.toLowerCase(), fileName: set.gist.file } : undefined;
const samePointer = (a?: GistPointer, b?: GistPointer) => !!a && !!b && gistKey(a) === gistKey(b);
const isYaml = (name: string) => /\.ya?ml$/i.test(name);

/** The exact YAML left on GitHub: the pointer is embedded only for the portable choice. */
export function publicationText(set: ProfileSet, pointer: GistPointer, storage: GistStorage) {
  const base = withoutGist(set);
  return serializeSet(
    storage === "portable" ? withGist(base, { id: pointer.gistId, file: pointer.fileName }) : base,
  );
}
function compare(before: ProfileSet | undefined, target: ProfileSet): GistComparison {
  const a = before?.profiles ?? [];
  return {
    before: a,
    target: target.profiles,
    diff: profilesDiff(a, target.profiles),
    ...(before && before.name !== target.name
      ? { nameChanged: { before: before.name, target: target.name } }
      : {}),
    ...((before?.appendSystemPrompt ?? "") !== (target.appendSystemPrompt ?? "")
      ? {
          systemPrompt: {
            before: before?.appendSystemPrompt ?? "",
            target: target.appendSystemPrompt ?? "",
          },
        }
      : {}),
  };
}
function parseRemote(text: string): { set?: ProfileSet; hasIdentity: boolean; error?: string } {
  try {
    const parsed = parseSet(text, "Gist pack");
    return { set: parsed.set, hasIdentity: parsed.hasIdentity };
  } catch (error) {
    return { hasIdentity: false, error: errorText(error) };
  }
}
function errorKind(error: unknown): "auth" | "not-found" | "other" {
  const status = (error as { status?: number }).status;
  if (status === 401 || /not authenticated|bad credentials/i.test(errorText(error))) return "auth";
  if (status === 404) return "not-found";
  return "other";
}
/** Files besides the bound one; scoped reads only return the bound file but report the total. */
const otherFiles = (doc: GistDocument, boundExists: boolean) =>
  Math.max(0, (doc.fileCount ?? doc.files.length) - (boundExists ? 1 : 0));
const slug = (name: string) => name.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 70) || "profiles";
const gistUrl = (id: string) => `https://gist.github.com/${id}`;

interface Context {
  store: LibraryStore;
  links: GistLinkStore;
  journal: GistJournal;
}
interface Resolved {
  entry: LibraryEntry;
  /** The host record, only when it belongs to this pack. */
  record?: HostLinkRecord;
  locations: Location[];
  distinct: GistPointer[];
  active?: GistPointer;
  conflict: boolean;
  storage?: GistStorage;
  repository?: string;
  confirmed: boolean;
  /** Changes whenever the saved pack or any link location changes. */
  key: string;
  operation?: PublishJournal;
  blockers: Blocker[];
}
interface Evaluation {
  state: GistState;
  blockers: Blocker[];
  ownership: "owner" | "not-owner";
  fileExists: boolean;
  remoteText?: string;
  remoteHash?: string;
  remoteSet?: ProfileSet;
  payloadText: string;
  payloadHash: string;
  contentHash: string;
  localChanged: boolean;
  remoteChanged: boolean;
  linkChange: boolean;
  alreadyEqual: boolean;
}
interface LinkPlan {
  id: string;
  root: string;
  expires: number;
  localId: string;
  entryRevision: string;
  key: string;
  pointer: GistPointer;
  storage: GistStorage;
  repository?: string;
  fileExists: boolean;
  remoteHash?: string;
  remoteText?: string;
  remoteRevision?: string;
  pendingFirstPublish: boolean;
  doc: { url: string; ownerId: number; ownerLogin: string; public: boolean };
  blockers: Blocker[];
  committed?: boolean;
}
interface PublishPlan {
  id: string;
  root: string;
  expires: number;
  mode: "revision" | "new";
  localId: string;
  packId: string;
  entryRevision: string;
  key: string;
  storage: GistStorage;
  repository?: string;
  pointer?: GistPointer;
  fileName: string;
  fileExists: boolean;
  remoteHash?: string;
  remoteRevision?: string;
  payloadText: string;
  payloadHash: string;
  contentHash: string;
  firstText?: string;
  actions: string[];
  requiresOverwrite: boolean;
  requiresTargetConfirmation: boolean;
  alreadyEqual: boolean;
  account: GistAccount;
  pendingFirstPublish: boolean;
  newGist?: { public: boolean; description: string };
  committed?: boolean;
}

export interface GistPublicationOptions {
  /** Resolves the library store for a requested root (the configured one when empty). */
  store: (libraryRoot: string) => Promise<LibraryStore>;
  gateway?: GistGateway;
  fault?: Fault;
  now?: () => Date;
}

export class GistPublicationService {
  private readonly gateway: GistGateway;
  private readonly fault: Fault;
  private readonly now: () => Date;
  private readonly resolveStore: GistPublicationOptions["store"];
  private readonly links = new Map<string, LinkPlan>();
  private readonly publishes = new Map<string, PublishPlan>();
  private readonly inflight = new Set<string>();
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(options: GistPublicationOptions) {
    this.resolveStore = options.store;
    this.gateway = options.gateway ?? ghGistGateway;
    this.fault = options.fault ?? (() => {});
    this.now = options.now ?? (() => new Date());
  }

  // ---- shared plumbing -------------------------------------------------------------------------

  private stamp() {
    return this.now().toISOString();
  }
  private async context(libraryRoot: string): Promise<Context> {
    const store = await this.resolveStore(libraryRoot);
    return { store, links: new GistLinkStore(store), journal: new GistJournal(store) };
  }
  /** One publication action per pack at a time; never the library lock, so no lock spans a request. */
  private exclusive<T>(ctx: Context, localId: string, action: () => Promise<T>): Promise<T> {
    const key = `${ctx.store.root}\u0000${localId}`;
    const pending = (this.chains.get(key) ?? Promise.resolve()).then(action);
    const tail = pending.catch(() => {});
    this.chains.set(key, tail);
    void tail.then(() => {
      if (this.chains.get(key) === tail) this.chains.delete(key);
    });
    return pending;
  }
  private remember<T extends { id: string; expires: number }>(map: Map<string, T>, plan: T): T {
    for (const [id, existing] of map) if (existing.expires < Date.now()) map.delete(id);
    if (map.size >= 100)
      throw new Error("Too many pending reviews. Close old reviews and try again.");
    map.set(plan.id, plan);
    return plan;
  }
  private plan<T extends { root: string; expires: number }>(
    map: Map<string, T>,
    id: string,
    ctx: Context,
  ): T {
    const plan = map.get(id);
    if (!plan || plan.expires < Date.now())
      throw new Error("Review expired or plugin restarted. Create a fresh preview.");
    if (plan.root !== ctx.store.root) throw new Error("Library folder changed. Review again.");
    return plan;
  }

  // ---- link state ------------------------------------------------------------------------------

  private async resolve(
    ctx: Context,
    entry: LibraryEntry,
    unresolved?: PublishJournal[],
  ): Promise<Resolved> {
    const packId = entry.set.id;
    const blockers: Blocker[] = [];
    const raw = await ctx.links.read(entry.localId).catch((error: unknown) => {
      blockers.push({ code: "identity-mismatch", message: errorText(error) });
      return undefined;
    });
    let record = raw;
    if (raw && raw.packId !== packId) {
      blockers.push({
        code: "identity-mismatch",
        message: "Saved link state belongs to a different pack and was ignored.",
      });
      record = undefined;
    }
    const locations: Location[] = [];
    if (record?.pointer)
      locations.push({
        location: "host",
        pointer: record.pointer,
        path: ctx.links.recordPath(entry.localId),
      });
    if (record?.repository) {
      const file = sidecarPath(record.repository, packId);
      try {
        const sidecar = await readSidecar(record.repository, packId);
        locations.push({
          location: "repository",
          path: file,
          ...(sidecar
            ? { pointer: { gistId: sidecar.gistId.toLowerCase(), fileName: sidecar.fileName } }
            : {}),
        });
      } catch (error) {
        locations.push({ location: "repository", path: file, problem: errorText(error) });
      }
    }
    const portable = pointerOf(entry.set);
    if (portable) locations.push({ location: "portable", pointer: portable, path: "pack" });

    const distinct: GistPointer[] = [];
    for (const { pointer } of locations)
      if (pointer && !distinct.some((p) => samePointer(p, pointer))) distinct.push(pointer);
    const conflict = distinct.length > 1;
    const active = distinct.length === 1 ? distinct[0] : undefined;
    const holders = locations.filter((l) => l.pointer);
    const storage = active
      ? (holders.find((l) => l.location === record?.storage) ?? holders[0])?.location
      : undefined;
    if (conflict)
      blockers.push({
        code: "link-conflict",
        message: "Different Gist links are saved in different places. Choose the one to keep.",
      });
    const confirmed =
      !!active &&
      !!record?.trusted &&
      samePointer({ gistId: record.trusted.gistId, fileName: record.trusted.fileName }, active);
    const open = (unresolved ?? (await ctx.journal.unresolved(entry.localId))).filter(
      (j) => j.localId === entry.localId,
    );
    const operation = open[0];
    if (operation)
      blockers.push({
        code: "unresolved-operation",
        message: "An earlier publication did not finish. Resolve it first.",
      });
    if (active && !confirmed && !conflict)
      blockers.push({
        code: "needs-confirmation",
        message: "This Gist link has not been confirmed on this Paseo host.",
      });
    return {
      entry,
      record,
      locations,
      distinct,
      active,
      conflict,
      storage,
      repository: record?.repository,
      confirmed,
      key: hash({ revision: entry.revision, record: record ?? null, locations }),
      operation,
      blockers,
    };
  }

  private summarize(journal: PublishJournal, extra?: Partial<GistOperation>): GistOperation {
    const inflight = this.inflight.has(journal.id);
    const embed = journal.step === "embed";
    let status = journal.status;
    if (status === "sending" && !inflight) status = "unknown";
    const phase: GistOperation["phase"] =
      status === "complete"
        ? "complete"
        : status === "dismissed"
          ? "dismissed"
          : status === "failed"
            ? "rejected"
            : status === "sending"
              ? "in-progress"
              : status === "unknown"
                ? "outcome-unknown"
                : status === "created" && embed
                  ? "gist-created-link-unfinished"
                  : status === "created" || status === "remote-confirmed"
                    ? "published-local-save-pending"
                    : "not-sent";
    const message: Record<GistOperation["phase"], string> = {
      "in-progress": "Publishing to GitHub…",
      "not-sent": "Nothing was sent to GitHub.",
      "outcome-unknown":
        journal.kind === "new"
          ? "Paseo cannot tell whether GitHub created the Gist. Check again before trying a second time."
          : "Paseo cannot tell whether GitHub saved the update. Check again or open the Gist on GitHub.",
      "gist-created-link-unfinished": "Gist created; link embedding unfinished.",
      "published-local-save-pending":
        "GitHub has your changes; Paseo has not finished saving the link on this host.",
      complete: "Published.",
      rejected: journal.error ?? "GitHub did not accept the request. Nothing changed.",
      dismissed: journal.error ?? "Closed without finishing.",
    };
    const actions: GistOperation["nextActions"] =
      phase === "outcome-unknown"
        ? ["check", "dismiss"]
        : phase === "gist-created-link-unfinished"
          ? ["finish", "check", "dismiss"]
          : phase === "published-local-save-pending"
            ? ["finish", "dismiss"]
            : [];
    return {
      id: journal.id,
      kind: journal.kind,
      status,
      phase,
      message: message[phase],
      ...(journal.error ? { error: journal.error } : {}),
      createdAt: journal.createdAt,
      updatedAt: journal.updatedAt,
      localId: journal.localId,
      packId: journal.packId,
      gist: {
        ...(journal.gist ? { id: journal.gist.id, url: journal.gist.url } : {}),
        fileName: journal.fileName,
        ...(journal.gist ? { public: journal.gist.public } : {}),
      },
      ...(journal.revision ? { revision: journal.revision } : {}),
      nextActions: actions,
      candidates: [],
      ...extra,
    };
  }

  private evaluate(r: Resolved, doc: GistDocument, account: GistAccount): Evaluation {
    const pointer = r.active as GistPointer;
    const storage = r.storage as GistStorage;
    const { entry, record } = r;
    const payloadText = publicationText(entry.set, pointer, storage);
    const payloadHash = fileHash(payloadText);
    const contentHash = publicationHash(entry.set);
    const ownership = account.id === doc.owner.id ? "owner" : "not-owner";
    const blockers: Blocker[] = [];
    if (ownership === "not-owner")
      blockers.push({
        code: "not-owner",
        message: `@${account.login} is not the owner (@${doc.owner.login}); this Gist is read-only here.`,
      });
    const file = doc.files.find((f) => f.name === pointer.fileName);
    let remoteSet: ProfileSet | undefined;
    let hard = false;
    if (!file) {
      if (!(record?.pendingFirstPublish && r.confirmed)) {
        hard = true;
        blockers.push({
          code: "file-missing",
          message: `${pointer.fileName} is no longer in this Gist; it will not be silently recreated.`,
        });
      }
    } else if (!isYaml(file.name)) {
      hard = true;
      blockers.push({
        code: "json-file",
        message: "Publishing only writes YAML files; this link points at another file type.",
      });
    } else {
      const parsed = parseRemote(file.text);
      if (parsed.error) {
        hard = true;
        blockers.push({
          code: "remote-invalid",
          message: `The Gist file could not be read as a profile pack: ${parsed.error}`,
        });
      } else if (!parsed.hasIdentity || parsed.set?.id !== entry.set.id) {
        hard = true;
        blockers.push({
          code: "pack-id-mismatch",
          message: "The Gist file belongs to a different pack and will not be overwritten.",
        });
      } else remoteSet = parsed.set;
    }
    const remoteHash = file ? fileHash(file.text) : undefined;
    const remoteContent = remoteSet ? publicationHash(remoteSet) : undefined;
    const baseline = record?.baseline;
    const alreadyEqual = !!file && remoteHash === payloadHash;
    const localChanged = !baseline || contentHash !== baseline.contentHash;
    const remoteChanged = file
      ? baseline
        ? remoteHash !== baseline.fileHash &&
          (remoteContent === undefined || remoteContent !== baseline.contentHash)
        : remoteHash !== payloadHash
      : false;
    const linkChange = !!file && !!baseline && !localChanged && !remoteChanged && !alreadyEqual;
    let state: GistState;
    if (hard) state = "blocked";
    else if (!r.confirmed) state = "needs-confirmation";
    else if (!file) state = "pending-first-publish";
    else if (alreadyEqual)
      state =
        baseline && baseline.fileHash === remoteHash && baseline.contentHash === contentHash
          ? "up-to-date"
          : "baseline-refresh";
    else if (remoteChanged) state = localChanged ? "both-changed" : "remote-changed";
    else state = localChanged ? "unpublished-changes" : "link-change";
    return {
      state,
      blockers,
      ownership,
      fileExists: !!file,
      remoteText: file?.text,
      remoteHash,
      remoteSet,
      payloadText,
      payloadHash,
      contentHash,
      localChanged,
      remoteChanged,
      linkChange,
      alreadyEqual,
    };
  }

  private buildStatus(
    r: Resolved,
    extra: {
      checked: boolean;
      doc?: GistDocument;
      account?: GistAccount;
      evaluation?: Evaluation;
      checkError?: GistStatus["checkError"];
    },
  ): GistStatus {
    const { entry, record, active } = r;
    const evaluation = extra.evaluation;
    const localChanged = active
      ? evaluation
        ? evaluation.localChanged
        : !record?.baseline || publicationHash(entry.set) !== record.baseline.contentHash
      : false;
    let state: GistState;
    if (r.operation) state = "unresolved-operation";
    else if (r.conflict) state = "link-conflict";
    else if (!active) state = "unlinked";
    else if (extra.checkError?.kind === "auth") state = "check-github-account";
    else if (extra.checkError?.kind === "not-found") state = "blocked";
    else if (extra.checkError) state = "check-failed";
    else if (evaluation) state = evaluation.state;
    else if (!r.confirmed) state = "needs-confirmation";
    else if (record?.pendingFirstPublish) state = "pending-first-publish";
    else state = localChanged ? "unpublished-changes" : "up-to-date";
    const doc = extra.doc;
    const blockers = [
      ...r.blockers.filter((b) => b.code !== "needs-confirmation" || !active || !r.confirmed),
    ];
    for (const b of evaluation?.blockers ?? []) blockers.push(b);
    const ownership: GistStatus["ownership"] = evaluation?.ownership ?? "unknown";
    return {
      localId: entry.localId,
      packId: entry.set.id,
      state,
      ...(active ? { pointer: active } : {}),
      ...(active
        ? {
            url:
              doc?.url ??
              (record?.lastKnown?.url?.includes(active.gistId)
                ? record.lastKnown.url
                : gistUrl(active.gistId)),
          }
        : {}),
      ...(r.storage ? { storage: r.storage } : {}),
      ...(r.repository ? { repository: r.repository } : {}),
      ...(r.repository ? { sidecarPath: sidecarPath(r.repository, entry.set.id) } : {}),
      locations: r.locations,
      confirmed: r.confirmed,
      pendingFirstPublish: !!record?.pendingFirstPublish,
      localChanged,
      ...(record?.baseline ? { baseline: record.baseline } : {}),
      blockers,
      previous: record?.previous ?? [],
      ...(r.operation ? { operation: this.summarize(r.operation) } : {}),
      checked: extra.checked,
      ...(extra.checked
        ? { lastCheckedAt: this.stamp() }
        : record?.lastCheckedAt
          ? { lastCheckedAt: record.lastCheckedAt }
          : {}),
      ...(extra.account ? { account: extra.account } : {}),
      ownership,
      ...(doc && active
        ? {
            remote: {
              id: doc.id,
              url: doc.url,
              owner: doc.owner,
              public: doc.public,
              ...(doc.revision ? { revision: doc.revision } : {}),
              ...(doc.updatedAt ? { updatedAt: doc.updatedAt } : {}),
              fileExists: evaluation?.fileExists ?? false,
              ...(evaluation?.remoteHash ? { fileHash: evaluation.remoteHash } : {}),
              otherFileCount: otherFiles(doc, evaluation?.fileExists ?? false),
            },
          }
        : {}),
      ...(extra.checkError ? { checkError: extra.checkError } : {}),
    };
  }

  private async statusFor(ctx: Context, localId: string, check = false): Promise<GistStatus> {
    const entry = await ctx.store.read(localId);
    const r = await this.resolve(ctx, entry);
    if (!check || !r.active || r.conflict) return this.buildStatus(r, { checked: false });
    let account: GistAccount;
    let doc: GistDocument;
    try {
      account = await this.gateway.account();
    } catch (error) {
      return this.buildStatus(r, {
        checked: true,
        checkError: { kind: errorKind(error), message: errorText(error) },
      });
    }
    try {
      doc = await this.gateway.read(r.active.gistId, r.active.fileName);
    } catch (error) {
      const kind = errorKind(error);
      const status = this.buildStatus(r, {
        checked: true,
        account,
        checkError: { kind, message: errorText(error) },
      });
      if (kind === "not-found")
        status.blockers.push({ code: "gist-not-found", message: "GitHub cannot find this Gist." });
      return status;
    }
    const evaluation = this.evaluate(r, doc, account);
    await this.recordCheck(ctx, entry, doc);
    return this.buildStatus(r, { checked: true, doc, account, evaluation });
  }

  private async recordCheck(ctx: Context, entry: LibraryEntry, doc: GistDocument) {
    await ctx.store.locked(async () => {
      const record = await ctx.links.read(entry.localId);
      if (!record || record.packId !== entry.set.id) return;
      await ctx.links.write({
        ...record,
        lastCheckedAt: this.stamp(),
        lastKnown: {
          url: doc.url,
          ownerId: doc.owner.id,
          ownerLogin: doc.owner.login,
          public: doc.public,
        },
      });
    });
  }

  // ---- public: inspect and status -------------------------------------------------------------

  async inspect(
    input: RpcInput<typeof contracts.inspectGist>,
  ): Promise<Out<typeof contracts.inspectGist>> {
    if (!input.url && !input.gistId) throw new Error("Enter a GitHub Gist URL.");
    const gistId = input.gistId ? input.gistId.toLowerCase() : gistIdFromUrl(input.url as string);
    const ctx = await this.context(input.libraryRoot);
    const packId = input.localId ? (await ctx.store.read(input.localId)).set.id : undefined;
    const account = await this.gateway.account();
    const doc = await this.gateway.read(gistId);
    const files = doc.files.map((file) => {
      const kind = isYaml(file.name) ? "yaml" : /\.json$/i.test(file.name) ? "json" : "other";
      const parsed = kind === "other" ? undefined : parseRemote(file.text);
      const identity = parsed?.set && parsed.hasIdentity ? parsed.set : undefined;
      const matchesPack = packId && identity ? identity.id === packId : undefined;
      return {
        name: file.name,
        bytes: Buffer.byteLength(file.text, "utf8"),
        kind: kind as "yaml" | "json" | "other",
        ...(identity ? { packId: identity.id, packName: identity.name } : {}),
        ...(parsed?.set ? { profileCount: parsed.set.profiles.length } : {}),
        ...(parsed?.error ? { parseError: parsed.error } : {}),
        ...(matchesPack !== undefined ? { matchesPack } : {}),
        linkable: kind === "yaml" && !!identity && (packId === undefined || identity.id === packId),
      };
    });
    const matching = files.filter((f) => f.kind === "yaml" && f.matchesPack === true);
    return {
      gist: {
        id: doc.id,
        url: doc.url,
        owner: doc.owner,
        public: doc.public,
        ...(doc.revision ? { revision: doc.revision } : {}),
        ...(doc.updatedAt ? { updatedAt: doc.updatedAt } : {}),
      },
      account,
      ownership: account.id === doc.owner.id ? "owner" : "not-owner",
      files,
      ...(matching.length === 1 ? { suggestedFile: matching[0].name } : {}),
    };
  }

  async status(
    input: RpcInput<typeof contracts.gistStatus>,
  ): Promise<Out<typeof contracts.gistStatus>> {
    const ctx = await this.context(input.libraryRoot);
    if (input.check && input.localIds?.length !== 1)
      throw new Error("Checking GitHub needs exactly one saved pack.");
    const listed = await ctx.store.list();
    const wanted = input.localIds ? new Set(input.localIds) : undefined;
    const entries = listed.entries.filter((e) => !wanted || wanted.has(e.localId));
    if (wanted && entries.length !== wanted.size) throw new Error("A saved pack no longer exists.");
    const unresolved = await ctx.journal.unresolved();
    const statuses: GistStatus[] = [];
    for (const entry of entries) {
      const r = await this.resolve(ctx, entry, unresolved);
      statuses.push(
        input.check
          ? await this.statusFor(ctx, entry.localId, true)
          : this.buildStatus(r, { checked: false }),
      );
    }
    return { statuses };
  }

  // ---- local link writes -----------------------------------------------------------------------

  /**
   * Writes (or, with no pointer, removes) the link wherever the chosen storage keeps it.
   * The caller holds the library lock. Order matters: pointer locations first, host record last, so
   * an interrupted write shows as a visible conflict or unconfirmed pointer, never a silent success.
   */
  private async applyLink(
    ctx: Context,
    args: {
      entry: LibraryEntry;
      pointer?: GistPointer;
      storage: GistStorage;
      repository?: string;
      owner?: { id: number; login: string };
      gist?: { url: string; public: boolean };
      baseline?: GistBaseline;
      baselineText?: string;
      pendingFirstPublish?: boolean;
      replaced: GistPointer[];
      reason: "switched" | "relinked" | "unlinked";
    },
  ): Promise<LibraryEntry> {
    const { entry, pointer } = args;
    const packId = entry.set.id;
    await this.fault("gistBeforeLinkWrite");
    const before = await ctx.links.read(entry.localId).catch(() => undefined);
    const prior = before && before.packId === packId ? before : undefined;
    const yaml = pointerOf(entry.set);
    let current = entry;
    if (pointer && args.storage === "portable") {
      if (!samePointer(yaml, pointer))
        current = await ctx.store.saveUnlocked(
          withGist(entry.set, { id: pointer.gistId, file: pointer.fileName }),
          entry.localId,
          entry.revision,
        );
    } else if (yaml) {
      current = await ctx.store.saveUnlocked(withoutGist(entry.set), entry.localId, entry.revision);
    }
    if (pointer && args.storage === "repository") {
      if (!args.repository) throw new Error("A repository folder is required for this link.");
      await writeSidecar(args.repository, {
        format: "paseo-profile-gist-link",
        version: 1,
        packId,
        gistId: pointer.gistId,
        fileName: pointer.fileName,
        ...(args.baseline?.revision ? { lastConfirmedRevision: args.baseline.revision } : {}),
        ...(args.baseline ? { lastPublishedFileHash: args.baseline.fileHash } : {}),
      });
    }
    if (
      prior?.repository &&
      !(args.storage === "repository" && args.repository === prior.repository)
    )
      await removeSidecar(prior.repository, packId).catch(() => false);
    const stamp = this.stamp();
    const previous = [...(prior?.previous ?? [])];
    for (const old of args.replaced) {
      if (samePointer(old, pointer) || previous.some((p) => samePointer(p, old))) continue;
      const known = prior?.trusted && samePointer(prior.trusted, old) ? prior.lastKnown : undefined;
      previous.push({
        gistId: old.gistId,
        fileName: old.fileName,
        url: known?.url ?? gistUrl(old.gistId),
        ...(known?.ownerLogin ? { ownerLogin: known.ownerLogin } : {}),
        ...(known?.public !== undefined ? { public: known.public } : {}),
        ...(prior?.baseline?.revision && prior.trusted && samePointer(prior.trusted, old)
          ? { lastRevision: prior.baseline.revision }
          : {}),
        replacedAt: stamp,
        reason: args.reason,
      });
    }
    const record: HostLinkRecord = {
      format: "paseo-profile-gist-host-link",
      version: 1,
      localId: entry.localId,
      packId,
      storage: args.storage,
      ...(pointer && args.storage === "repository" && args.repository
        ? { repository: args.repository }
        : {}),
      ...(pointer && args.storage === "host" ? { pointer } : {}),
      ...(args.pendingFirstPublish ? { pendingFirstPublish: true } : {}),
      ...(pointer
        ? {
            trusted: {
              gistId: pointer.gistId,
              fileName: pointer.fileName,
              ...(args.owner ? { ownerId: args.owner.id, ownerLogin: args.owner.login } : {}),
              confirmedAt: stamp,
            },
          }
        : {}),
      ...(pointer && args.baseline ? { baseline: args.baseline } : {}),
      previous,
      ...(pointer ? { lastCheckedAt: stamp } : {}),
      ...(pointer && args.gist
        ? {
            lastKnown: {
              url: args.gist.url,
              public: args.gist.public,
              ...(args.owner ? { ownerId: args.owner.id, ownerLogin: args.owner.login } : {}),
            },
          }
        : {}),
    };
    await ctx.links.write(record);
    await ctx.links.writeBaselineText(entry.localId, pointer ? args.baselineText : undefined);
    return current === entry ? await ctx.store.read(entry.localId) : current;
  }

  private async guardUnresolved(ctx: Context, localId: string) {
    if ((await ctx.journal.unresolved(localId)).length)
      throw new Error("An earlier publication did not finish. Resolve it first.");
  }

  // ---- public: link ----------------------------------------------------------------------------

  async linkPreview(
    input: RpcInput<typeof contracts.gistLinkPreview>,
  ): Promise<Out<typeof contracts.gistLinkPreview>> {
    const ctx = await this.context(input.libraryRoot);
    if (!isSafeGistFileName(input.fileName))
      throw new Error("That Gist file name is not supported.");
    const entry = await ctx.store.assertRevision(input.localId, input.expectedRevision);
    const r = await this.resolve(ctx, entry);
    if (r.operation) throw new Error("An earlier publication did not finish. Resolve it first.");
    let repository: string | undefined;
    let destination: string | undefined;
    let existingSidecar: GistPointer | undefined;
    if (input.storage === "repository") {
      if (!input.repository) throw new Error("Enter the repository folder on this Paseo host.");
      repository = await resolveRepository(input.repository);
      destination = sidecarPath(repository, entry.set.id);
      const found = await readSidecar(repository, entry.set.id);
      if (found) existingSidecar = { gistId: found.gistId.toLowerCase(), fileName: found.fileName };
    } else if (input.storage === "host") destination = ctx.links.recordPath(entry.localId);
    const account = await this.gateway.account();
    const doc = await this.gateway.read(input.gistId, input.fileName);
    const owner = account.id === doc.owner.id;
    const pointer: GistPointer = { gistId: doc.id.toLowerCase(), fileName: input.fileName };
    const file = doc.files.find((f) => f.name === input.fileName);
    const blockers: Blocker[] = [];
    let pendingFirstPublish = false;
    let comparison: GistComparison | undefined;
    let identical = false;
    if (file) {
      if (!isYaml(file.name))
        blockers.push({
          code: "json-file",
          message:
            "Publishing writes YAML. Import this JSON file through the Gist import flow, or choose a YAML file.",
        });
      else {
        const parsed = parseRemote(file.text);
        if (parsed.error)
          blockers.push({
            code: "remote-invalid",
            message: `Could not read the file: ${parsed.error}`,
          });
        else if (!parsed.hasIdentity || parsed.set?.id !== entry.set.id)
          blockers.push({
            code: "pack-id-mismatch",
            message: "That file belongs to a different pack and cannot be linked to this one.",
          });
        else if (parsed.set) {
          comparison = compare(parsed.set, entry.set);
          identical =
            fileHash(file.text) === fileHash(publicationText(entry.set, pointer, input.storage));
        }
      }
    } else if (!isYaml(input.fileName))
      blockers.push({
        code: "file-missing",
        message: "Choose an existing file, or enter a new file name ending in .yaml.",
      });
    else if (!owner)
      blockers.push({
        code: "not-owner",
        message: `@${account.login} cannot add a file to a Gist owned by @${doc.owner.login}.`,
      });
    else pendingFirstPublish = true;
    const warnings = [
      doc.public
        ? "This is a public Gist."
        : "This is a secret Gist: anyone with its URL can read it and its history.",
    ];
    if (input.storage === "repository")
      warnings.push(
        "Teammates receive this link only after you commit and push the sidecar file. Paseo does not run Git.",
      );
    if (input.storage === "portable")
      warnings.push(
        "The link is saved in the pack file, so full-pack exports and Gist publications carry it.",
      );
    if (!owner)
      warnings.push(`Publishing is unavailable: @${account.login} does not own this Gist.`);
    warnings.push("Nothing is sent to GitHub.");
    const plan = this.remember(this.links, {
      id: randomUUID(),
      root: ctx.store.root,
      expires: Date.now() + PREVIEW_TTL_MS,
      localId: entry.localId,
      entryRevision: entry.revision,
      key: r.key,
      pointer,
      storage: input.storage,
      repository,
      fileExists: !!file,
      remoteHash: file ? fileHash(file.text) : undefined,
      remoteText: file?.text,
      remoteRevision: doc.revision,
      pendingFirstPublish,
      doc: { url: doc.url, ownerId: doc.owner.id, ownerLogin: doc.owner.login, public: doc.public },
      blockers,
    });
    return {
      previewId: plan.id,
      gist: {
        id: doc.id,
        url: doc.url,
        owner: doc.owner,
        public: doc.public,
        ...(doc.revision ? { revision: doc.revision } : {}),
        ...(doc.updatedAt ? { updatedAt: doc.updatedAt } : {}),
      },
      account,
      ownership: owner ? "owner" : "not-owner",
      fileName: input.fileName,
      fileExists: !!file,
      pendingFirstPublish,
      canPublish: owner,
      storage: input.storage,
      ...(destination ? { destination } : {}),
      ...(repository ? { repository } : {}),
      upgradesPackFormat: input.storage === "portable" && !entry.set.gist,
      ...(input.storage === "portable"
        ? { minimumPluginVersion: PORTABLE_LINK_MIN_PLUGIN_VERSION }
        : {}),
      replaces: r.locations.filter((l) => l.pointer),
      ...(existingSidecar ? { existingSidecar } : {}),
      ...(comparison ? { comparison } : {}),
      identical,
      visibility: doc.public ? "public" : "secret",
      warnings,
      blockers,
    };
  }

  async linkCommit(
    input: RpcInput<typeof contracts.gistLinkCommit>,
  ): Promise<Out<typeof contracts.gistLinkCommit>> {
    const ctx = await this.context(input.libraryRoot);
    const plan = this.plan(this.links, input.previewId, ctx);
    if (plan.committed) throw new Error("This link review was already submitted.");
    if (plan.blockers.length) throw new Error(plan.blockers[0].message);
    const entry = await this.exclusive(ctx, plan.localId, async () => {
      const doc = await this.gateway.read(plan.pointer.gistId, plan.pointer.fileName);
      const file = doc.files.find((f) => f.name === plan.pointer.fileName);
      if ((file ? fileHash(file.text) : undefined) !== plan.remoteHash)
        throw new Error("The Gist file changed since the review. Check the Gist again.");
      const remoteSet = file ? parseRemote(file.text).set : undefined;
      const saved = await ctx.store.locked(async () => {
        const current = await ctx.store.assertRevision(plan.localId, plan.entryRevision);
        const r = await this.resolve(ctx, current);
        if (r.key !== plan.key)
          throw new Error("The saved pack or its link changed since the review. Review again.");
        if (r.operation)
          throw new Error("An earlier publication did not finish. Resolve it first.");
        const stamp = this.stamp();
        const relink = r.distinct.some((p) => !samePointer(p, plan.pointer));
        return this.applyLink(ctx, {
          entry: current,
          pointer: plan.pointer,
          storage: plan.storage,
          repository: plan.repository,
          owner: { id: plan.doc.ownerId, login: plan.doc.ownerLogin },
          gist: { url: plan.doc.url, public: plan.doc.public },
          ...(file && remoteSet
            ? {
                baseline: {
                  ...(doc.revision ? { revision: doc.revision } : {}),
                  fileHash: fileHash(file.text),
                  contentHash: publicationHash(remoteSet),
                  recordedAt: stamp,
                  source: "linked" as const,
                },
                baselineText: file.text,
              }
            : {}),
          pendingFirstPublish: plan.pendingFirstPublish,
          replaced: r.distinct,
          reason: relink ? "relinked" : "switched",
        });
      });
      plan.committed = true;
      return saved;
    });
    return { entry, status: await this.statusFor(ctx, plan.localId) };
  }

  async unlink(
    input: RpcInput<typeof contracts.gistUnlink>,
  ): Promise<Out<typeof contracts.gistUnlink>> {
    const ctx = await this.context(input.libraryRoot);
    const entry = await this.exclusive(ctx, input.localId, () =>
      ctx.store.locked(async () => {
        const current = await ctx.store.assertRevision(input.localId, input.expectedRevision);
        const r = await this.resolve(ctx, current);
        if (r.operation)
          throw new Error("An earlier publication did not finish. Resolve it first.");
        if (!r.distinct.length) throw new Error("This pack has no Gist link.");
        return this.applyLink(ctx, {
          entry: current,
          storage: r.record?.storage ?? "host",
          replaced: r.distinct,
          reason: "unlinked",
        });
      }),
    );
    return { entry, status: await this.statusFor(ctx, input.localId) };
  }

  // ---- public: publish preview -----------------------------------------------------------------

  async publishPreview(
    input: RpcInput<typeof contracts.gistPublishPreview>,
  ): Promise<Out<typeof contracts.gistPublishPreview>> {
    const ctx = await this.context(input.libraryRoot);
    const entry = await ctx.store.assertRevision(input.localId, input.expectedRevision);
    const r = await this.resolve(ctx, entry);
    if (r.operation) throw new Error("An earlier publication did not finish. Resolve it first.");
    const account = await this.gateway.account();
    return input.mode === "revision"
      ? this.previewRevision(ctx, r, account)
      : this.previewNew(ctx, r, account, input);
  }

  private async previewRevision(
    ctx: Context,
    r: Resolved,
    account: GistAccount,
  ): Promise<Out<typeof contracts.gistPublishPreview>> {
    const { entry, record } = r;
    if (r.conflict) throw new Error("Gist links conflict. Choose the link to keep first.");
    if (!r.active || !r.storage) throw new Error("This pack has no Gist link. Link a Gist first.");
    const pointer = r.active;
    const doc = await this.gateway.read(pointer.gistId, pointer.fileName);
    const ev = this.evaluate(r, doc, account);
    const owner = ev.ownership === "owner";
    let actions: Out<typeof contracts.gistPublishPreview>["actions"];
    let primaryAction: Out<typeof contracts.gistPublishPreview>["primaryAction"];
    let requiresOverwrite = false;
    if (ev.state === "blocked")
      actions = [...(ev.remoteSet ? ["review-updates" as const] : []), "publish-new"];
    else if (!owner) actions = ["review-updates", "publish-new"];
    else if (ev.state === "up-to-date") actions = ["publish-new"];
    else if (ev.alreadyEqual) {
      actions = ["refresh-baseline", "publish-new"];
      primaryAction = "refresh-baseline";
    } else if (ev.remoteChanged || (ev.state === "needs-confirmation" && ev.fileExists)) {
      actions = ["overwrite", "replace-saved-pack", "publish-new"];
      requiresOverwrite = true;
    } else {
      actions = ["publish", "publish-new"];
      primaryAction = "publish";
    }
    const baselineText = await ctx.links.readBaselineText(entry.localId);
    const baselineSet = baselineText ? parseRemote(baselineText).set : undefined;
    const target = {
      gistId: doc.id,
      url: doc.url,
      fileName: pointer.fileName,
      ownerLogin: doc.owner.login,
      public: doc.public,
    };
    const plan = this.remember(this.publishes, {
      id: randomUUID(),
      root: ctx.store.root,
      expires: Date.now() + PREVIEW_TTL_MS,
      mode: "revision",
      localId: entry.localId,
      packId: entry.set.id,
      entryRevision: entry.revision,
      key: r.key,
      storage: r.storage,
      repository: r.repository,
      pointer,
      fileName: pointer.fileName,
      fileExists: ev.fileExists,
      remoteHash: ev.remoteHash,
      remoteRevision: doc.revision,
      payloadText: ev.payloadText,
      payloadHash: ev.payloadHash,
      contentHash: ev.contentHash,
      actions,
      requiresOverwrite,
      requiresTargetConfirmation: !r.confirmed,
      alreadyEqual: ev.alreadyEqual,
      account,
      pendingFirstPublish: !!record?.pendingFirstPublish,
    });
    const warnings = [
      doc.public
        ? "This is a public Gist."
        : "This is a secret Gist: anyone with its URL can read it and its past revisions.",
      "GitHub keeps the last write. An edit made while publishing could be overwritten.",
    ];
    return {
      previewId: plan.id,
      mode: "revision",
      state: ev.state,
      account,
      ownership: ev.ownership,
      target,
      storage: r.storage,
      ...(r.repository ? { repository: r.repository } : {}),
      otherFileCount: otherFiles(doc, ev.fileExists),
      actions,
      ...(primaryAction ? { primaryAction } : {}),
      hashes: {
        payload: ev.payloadHash,
        ...(ev.remoteHash ? { remote: ev.remoteHash } : {}),
        ...(record?.baseline ? { baseline: record.baseline.fileHash } : {}),
      },
      remoteChanged: ev.remoteChanged,
      localChanged: ev.localChanged,
      linkChange: ev.linkChange,
      alreadyEqual: ev.alreadyEqual,
      requiresOverwrite,
      requiresTargetConfirmation: !r.confirmed,
      replace: compare(ev.remoteSet, entry.set),
      ...(ev.localChanged && baselineSet ? { localChange: compare(baselineSet, entry.set) } : {}),
      ...(ev.remoteChanged && baselineSet && ev.remoteSet
        ? { remoteChange: compare(baselineSet, ev.remoteSet) }
        : {}),
      upgradesPackFormat: false,
      twoStep: false,
      warnings,
      blockers: [...r.blockers.filter((b) => b.code !== "needs-confirmation"), ...ev.blockers],
      expiresAt: new Date(plan.expires).toISOString(),
    };
  }

  private async previewNew(
    ctx: Context,
    r: Resolved,
    account: GistAccount,
    input: RpcInput<typeof contracts.gistPublishPreview>,
  ): Promise<Out<typeof contracts.gistPublishPreview>> {
    const { entry } = r;
    const storage = input.storage ?? r.storage ?? "host";
    let repository: string | undefined;
    let destination: string | undefined;
    if (storage === "repository") {
      const entered = input.repository ?? r.repository;
      if (!entered) throw new Error("Enter the repository folder on this Paseo host.");
      repository = await resolveRepository(entered);
      destination = sidecarPath(repository, entry.set.id);
    } else if (storage === "host") destination = ctx.links.recordPath(entry.localId);
    const fileName = input.fileName ?? `${slug(entry.set.name)}.yaml`;
    if (!isSafeGistFileName(fileName) || !isYaml(fileName))
      throw new Error("Use a Gist file name ending in .yaml.");
    const description = input.description?.trim() || `Paseo agent profile pack: ${entry.set.name}`;
    const firstText = serializeSet(withoutGist(entry.set));
    const twoStep = storage === "portable";
    const payloadHash = fileHash(firstText);
    const contentHash = publicationHash(entry.set);
    const status = this.buildStatus(r, { checked: false });
    const plan = this.remember(this.publishes, {
      id: randomUUID(),
      root: ctx.store.root,
      expires: Date.now() + PREVIEW_TTL_MS,
      mode: "new",
      localId: entry.localId,
      packId: entry.set.id,
      entryRevision: entry.revision,
      key: r.key,
      storage,
      repository,
      fileName,
      fileExists: false,
      payloadText: firstText,
      payloadHash,
      contentHash,
      firstText: twoStep ? firstText : undefined,
      actions: ["publish-new"],
      requiresOverwrite: false,
      requiresTargetConfirmation: false,
      alreadyEqual: false,
      account,
      pendingFirstPublish: false,
      newGist: { public: input.public, description },
    });
    const warnings = [
      input.public
        ? "This will be a public Gist."
        : "This will be a secret Gist: anyone with its URL can read it and its past revisions.",
      "Future publishes use the new Gist. The old Gist stays online; people using its URL will not receive these updates.",
    ];
    if (twoStep)
      warnings.push(
        "Two steps: GitHub creates the Gist, then Paseo embeds the link into it. If the second step fails you can finish it without creating another Gist.",
      );
    return {
      previewId: plan.id,
      mode: "new",
      state: status.state,
      account,
      ownership: "owner",
      target: { fileName, ownerLogin: account.login, public: input.public, description },
      storage,
      ...(repository ? { repository } : {}),
      ...(destination ? { destination } : {}),
      otherFileCount: 0,
      actions: ["publish-new"],
      primaryAction: "publish-new",
      hashes: { payload: payloadHash },
      remoteChanged: false,
      localChanged: true,
      linkChange: false,
      alreadyEqual: false,
      requiresOverwrite: false,
      requiresTargetConfirmation: false,
      replace: compare(undefined, entry.set),
      upgradesPackFormat: storage === "portable" && !entry.set.gist,
      ...(storage === "portable" ? { minimumPluginVersion: PORTABLE_LINK_MIN_PLUGIN_VERSION } : {}),
      twoStep,
      warnings,
      blockers: [],
      expiresAt: new Date(plan.expires).toISOString(),
    };
  }

  // ---- public: publish commit ------------------------------------------------------------------

  async publishCommit(
    input: RpcInput<typeof contracts.gistPublishCommit>,
  ): Promise<Out<typeof contracts.gistPublishCommit>> {
    const ctx = await this.context(input.libraryRoot);
    // The preview ID is the operation ID: a repeated commit reconciles, it never writes again.
    if (/^[a-zA-Z0-9-]{8,64}$/.test(input.previewId)) {
      const existing = await ctx.journal.read(input.previewId);
      if (existing) return this.result(ctx, existing);
    }
    const plan = this.plan(this.publishes, input.previewId, ctx);
    return this.exclusive(ctx, plan.localId, async () => {
      if (plan.committed) throw new Error("This review was already submitted.");
      const refresh = input.refreshBaselineOnly;
      if (refresh && !plan.actions.includes("refresh-baseline"))
        throw new Error("This review does not offer a baseline refresh.");
      if (
        !refresh &&
        plan.mode === "revision" &&
        !plan.actions.some((a) => a === "publish" || a === "overwrite")
      )
        throw new Error("Publishing to this Gist is not available. Choose another action.");
      if (plan.requiresTargetConfirmation && !input.confirmTarget)
        throw new Error("Confirm the Gist target before publishing.");
      if (plan.requiresOverwrite && !refresh && !input.overwriteRemote)
        throw new Error(
          "The Gist file changed. Explicitly choose to overwrite it, or review again.",
        );
      await this.guardUnresolved(ctx, plan.localId);
      const entry = await ctx.store.read(plan.localId);
      const r = await this.resolve(ctx, entry);
      if (entry.revision !== plan.entryRevision || r.key !== plan.key)
        throw new Error("The saved pack or its link changed since the review. Review again.");
      const account = await this.gateway.account();
      if (account.id !== plan.account.id)
        throw new Error("The GitHub account on this host changed. Review again.");
      return plan.mode === "revision"
        ? this.commitRevision(ctx, plan, account, refresh)
        : this.commitNew(ctx, plan, r, account);
    });
  }

  private journalFor(
    plan: PublishPlan,
    account: GistAccount,
    extra: Partial<PublishJournal>,
  ): PublishJournal {
    const stamp = this.stamp();
    return {
      version: 1,
      id: plan.id,
      kind: plan.mode,
      status: "sending",
      createdAt: stamp,
      updatedAt: stamp,
      localId: plan.localId,
      packId: plan.packId,
      localRevision: plan.entryRevision,
      storage: plan.storage,
      ...(plan.repository ? { repository: plan.repository } : {}),
      fileName: plan.fileName,
      account,
      confirmTarget: true,
      payload: { text: plan.payloadText, hash: plan.payloadHash, contentHash: plan.contentHash },
      step: plan.mode === "new" ? "create" : "write",
      pendingFirstPublish: plan.pendingFirstPublish,
      ...extra,
    };
  }

  private async commitRevision(
    ctx: Context,
    plan: PublishPlan,
    account: GistAccount,
    refresh: boolean,
  ): Promise<Out<typeof contracts.gistPublishCommit>> {
    const pointer = plan.pointer as GistPointer;
    // Reread immediately before writing; a change since the review returns to the review.
    const doc = await this.gateway.read(pointer.gistId, pointer.fileName);
    const file = doc.files.find((f) => f.name === pointer.fileName);
    const current = file ? fileHash(file.text) : undefined;
    if (account.id !== doc.owner.id)
      return {
        outcome: "rejected",
        message: `@${account.login} does not own this Gist (@${doc.owner.login}).`,
      };
    if (current !== plan.remoteHash)
      return {
        outcome: "remote-changed",
        message: "The Gist file changed after the review. Review the new differences.",
      };
    const equal = current === plan.payloadHash;
    if (refresh && !equal)
      return {
        outcome: "remote-changed",
        message: "The Gist file no longer matches the saved pack. Review again.",
      };
    const journal = this.journalFor(plan, account, {
      gist: {
        id: doc.id.toLowerCase(),
        url: doc.url,
        public: doc.public,
        ownerId: doc.owner.id,
        ownerLogin: doc.owner.login,
        ...(doc.revision ? { revision: doc.revision } : {}),
      },
      expectedRemote: { fileHash: current, revision: doc.revision },
      ...(equal
        ? { status: "remote-confirmed", revision: doc.revision, alreadyCurrent: true }
        : {}),
    });
    plan.committed = true;
    await this.fault("gistBeforeJournal");
    await ctx.journal.create(journal);
    await this.fault("gistAfterJournal");
    if (!equal) await this.runWrite(ctx, journal);
    return this.finish(ctx, journal);
  }

  private async commitNew(
    ctx: Context,
    plan: PublishPlan,
    r: Resolved,
    account: GistAccount,
  ): Promise<Out<typeof contracts.gistPublishCommit>> {
    const journal = this.journalFor(plan, account, {
      newGist: plan.newGist,
      firstText: plan.firstText
        ? { text: plan.firstText, hash: fileHash(plan.firstText) }
        : undefined,
      replaced: r.distinct,
    });
    plan.committed = true;
    await this.fault("gistBeforeJournal");
    await ctx.journal.create(journal);
    await this.fault("gistAfterJournal");
    await this.runCreate(ctx, journal);
    return this.finish(ctx, journal);
  }

  /** After the remote steps: finish local state when GitHub confirmed, and report the outcome. */
  private async finish(ctx: Context, journal: PublishJournal) {
    if (journal.status === "remote-confirmed") {
      try {
        await this.finishLocal(ctx, journal);
      } catch (error) {
        journal.error = errorText(error);
        await ctx.journal.save(journal, this.stamp()).catch(() => {});
      }
    }
    return this.result(ctx, journal);
  }

  private async markFailed(ctx: Context, journal: PublishJournal, error: unknown) {
    journal.error = errorText(error);
    if (journal.step === "embed" && journal.gist) journal.status = "created";
    else journal.status = isWriteOutcomeUnknown(error) ? "unknown" : "failed";
    await ctx.journal.save(journal, this.stamp()).catch(() => {});
  }

  private async confirmWrite(
    journal: PublishJournal,
    doc: GistDocument,
  ): Promise<{ ok: boolean; revision?: string; by: "response" | "readback" }> {
    const matches = (d: GistDocument) => {
      const f = d.files.find((x) => x.name === journal.fileName);
      return !!f && fileHash(f.text) === journal.payload.hash;
    };
    if (matches(doc)) return { ok: true, revision: doc.revision, by: "response" };
    try {
      const again = await this.gateway.read((journal.gist as { id: string }).id, journal.fileName);
      if (matches(again)) return { ok: true, revision: again.revision, by: "readback" };
    } catch {
      // Fall through: the write may have applied but cannot be verified.
    }
    return { ok: false, by: "readback" };
  }

  /** PATCH the bound file of a known Gist. Records unknown/rejected instead of throwing. */
  private async runWrite(ctx: Context, journal: PublishJournal) {
    this.inflight.add(journal.id);
    try {
      let doc: GistDocument;
      try {
        doc = await this.gateway.update({
          gistId: (journal.gist as { id: string }).id,
          fileName: journal.fileName,
          text: journal.payload.text,
        });
        await this.fault("gistAfterRemoteWrite");
      } catch (error) {
        await this.markFailed(ctx, journal, error);
        return;
      }
      const confirmed = await this.confirmWrite(journal, doc);
      if (!confirmed.ok) {
        journal.status = journal.step === "embed" ? "created" : "unknown";
        journal.error = "GitHub's answer did not show the expected file content.";
        await ctx.journal.save(journal, this.stamp()).catch(() => {});
        return;
      }
      journal.status = "remote-confirmed";
      journal.revision = confirmed.revision;
      journal.confirmedBy = confirmed.by;
      delete journal.error;
      // Same revision and content as before the write: GitHub made no new revision.
      if (
        journal.step === "write" &&
        confirmed.revision &&
        confirmed.revision === journal.expectedRemote?.revision
      )
        journal.alreadyCurrent = true;
      await ctx.journal.save(journal, this.stamp());
    } catch (error) {
      journal.error = errorText(error);
    } finally {
      this.inflight.delete(journal.id);
    }
  }

  private async runCreate(ctx: Context, journal: PublishJournal) {
    this.inflight.add(journal.id);
    try {
      let doc: GistDocument;
      try {
        doc = await this.gateway.create({
          files: [
            {
              name: journal.fileName,
              text: journal.firstText?.text ?? journal.payload.text,
            },
          ],
          description: journal.newGist?.description ?? "",
          public: journal.newGist?.public ?? false,
        });
        await this.fault(
          journal.storage === "portable" ? "gistAfterPortablePost" : "gistAfterRemoteWrite",
        );
      } catch (error) {
        await this.markFailed(ctx, journal, error);
        return;
      }
      journal.gist = {
        id: doc.id.toLowerCase(),
        url: doc.url,
        public: doc.public,
        ownerId: doc.owner.id,
        ownerLogin: doc.owner.login,
        ...(doc.revision ? { revision: doc.revision } : {}),
      };
      const created = doc.files.find((f) => f.name === journal.fileName);
      const expected = journal.firstText?.hash ?? journal.payload.hash;
      if (!created || fileHash(created.text) !== expected || doc.owner.id !== journal.account.id) {
        journal.status = "unknown";
        journal.error = "GitHub created a Gist, but its content is not what was sent.";
        await ctx.journal.save(journal, this.stamp()).catch(() => {});
        return;
      }
      if (journal.storage === "portable") {
        const parsed = parseSet(journal.firstText?.text ?? "").set;
        const text = serializeSet(
          withGist(parsed, { id: journal.gist.id, file: journal.fileName }),
        );
        journal.payload = { text, hash: fileHash(text), contentHash: journal.payload.contentHash };
        journal.step = "embed";
        journal.status = "created";
        await ctx.journal.save(journal, this.stamp());
        this.inflight.delete(journal.id);
        await this.runEmbed(ctx, journal);
        return;
      }
      journal.status = "remote-confirmed";
      journal.revision = doc.revision;
      journal.confirmedBy = "response";
      await ctx.journal.save(journal, this.stamp());
    } catch (error) {
      journal.error = errorText(error);
    } finally {
      this.inflight.delete(journal.id);
    }
  }

  /** Portable create, step two: PATCH the new Gist so its file points at itself. */
  private async runEmbed(ctx: Context, journal: PublishJournal) {
    this.inflight.add(journal.id);
    try {
      try {
        await this.fault("gistBeforePortablePatch");
        const doc = await this.gateway.update({
          gistId: (journal.gist as { id: string }).id,
          fileName: journal.fileName,
          text: journal.payload.text,
        });
        await this.fault("gistAfterPortablePatch");
        const confirmed = await this.confirmWrite(journal, doc);
        if (!confirmed.ok) throw new Error("GitHub's answer did not show the embedded link.");
        journal.status = "remote-confirmed";
        journal.revision = confirmed.revision;
        journal.confirmedBy = confirmed.by;
        delete journal.error;
        await ctx.journal.save(journal, this.stamp());
      } catch (error) {
        journal.status = "created";
        journal.error = errorText(error);
        await ctx.journal.save(journal, this.stamp()).catch(() => {});
      }
    } finally {
      this.inflight.delete(journal.id);
    }
  }

  /** Records the confirmed publication in local link state. Never contacts GitHub; safe to repeat. */
  private async finishLocal(ctx: Context, journal: PublishJournal): Promise<LibraryEntry> {
    const gist = journal.gist;
    if (!gist) throw new Error("The publication has no Gist to record.");
    await this.fault("gistBeforeLocalLinkSave");
    return ctx.store.locked(async () => {
      const entry = await ctx.store.read(journal.localId);
      if (entry.set.id !== journal.packId)
        throw new Error("The saved pack changed identity; the link was not recorded.");
      const pointer = { gistId: gist.id, fileName: journal.fileName };
      // The link may have been changed or removed since this operation began; never undo that.
      const now = await this.resolve(ctx, entry, []);
      const allowed = [pointer, ...(journal.kind === "new" ? (journal.replaced ?? []) : [])];
      const unchanged =
        !now.conflict &&
        now.distinct.every((p) => allowed.some((a) => samePointer(a, p))) &&
        (journal.kind === "new" || now.distinct.length > 0);
      if (!unchanged) {
        journal.status = "dismissed";
        journal.error =
          "GitHub has this change, but the pack's Gist link was changed before it was recorded. The current link was left as it is.";
        await ctx.journal.save(journal, this.stamp());
        return entry;
      }
      // An in-place publish keeps whichever storage the person has since chosen for the same Gist.
      const keep = journal.kind === "revision" && now.storage ? now : undefined;
      const saved = await this.applyLink(ctx, {
        entry,
        pointer,
        storage: keep?.storage ?? journal.storage,
        repository: keep ? keep.repository : journal.repository,
        owner: { id: gist.ownerId, login: gist.ownerLogin },
        gist: { url: gist.url, public: gist.public },
        baseline: {
          ...((journal.revision ?? gist.revision)
            ? { revision: journal.revision ?? gist.revision }
            : {}),
          fileHash: journal.payload.hash,
          contentHash: journal.payload.contentHash,
          recordedAt: this.stamp(),
          source: "published",
        },
        baselineText: journal.payload.text,
        replaced: journal.replaced ?? [],
        reason: "switched",
      });
      journal.status = "complete";
      delete journal.error;
      await ctx.journal.save(journal, this.stamp());
      return saved;
    });
  }

  private async result(
    ctx: Context,
    journal: PublishJournal,
  ): Promise<Out<typeof contracts.gistPublishCommit>> {
    const operation = this.summarize(journal);
    const outcome: Out<typeof contracts.gistPublishCommit>["outcome"] =
      operation.phase === "complete"
        ? journal.alreadyCurrent
          ? "already-up-to-date"
          : "published"
        : operation.phase === "gist-created-link-unfinished"
          ? "link-embedding-unfinished"
          : operation.phase === "published-local-save-pending"
            ? "partial-local-save"
            : operation.phase === "outcome-unknown" || operation.phase === "in-progress"
              ? "outcome-unknown"
              : "rejected";
    const status = await this.statusFor(ctx, journal.localId).catch(() => undefined);
    // This result already has confirmed account/owner evidence from the completed write.
    // Keep it in the response without another network read; preflight checks credentials again.
    if (
      status?.pointer &&
      journal.status === "complete" &&
      journal.gist &&
      samePointer(status.pointer, { gistId: journal.gist.id, fileName: journal.fileName })
    ) {
      status.account = journal.account;
      status.ownership = journal.account.id === journal.gist.ownerId ? "owner" : "not-owner";
    }
    const entry = await ctx.store.read(journal.localId).catch(() => undefined);
    return {
      outcome,
      message:
        outcome === "already-up-to-date"
          ? "Already up to date. GitHub made no new revision."
          : operation.message,
      operation,
      ...(journal.gist
        ? {
            gist: {
              id: (journal.gist as NonNullable<PublishJournal["gist"]>).id,
              url: (journal.gist as NonNullable<PublishJournal["gist"]>).url,
              fileName: journal.fileName,
              ...(journal.revision ? { revision: journal.revision } : {}),
              public: (journal.gist as NonNullable<PublishJournal["gist"]>).public,
            },
          }
        : {}),
      ...(status ? { status } : {}),
      ...(entry ? { entry } : {}),
    };
  }

  // ---- public: reconcile an unresolved operation ------------------------------------------------

  async publishOperation(
    input: RpcInput<typeof contracts.gistPublishOperation>,
  ): Promise<Out<typeof contracts.gistPublishOperation>> {
    const ctx = await this.context(input.libraryRoot);
    const found = await ctx.journal.read(input.operationId);
    if (!found) throw new Error("That publication record was not found.");
    return this.exclusive(ctx, found.localId, async () => {
      const journal = (await ctx.journal.read(input.operationId)) ?? found;
      // A "sending" record with no live request means the process stopped mid-request.
      if (journal.status === "sending" && !this.inflight.has(journal.id)) {
        journal.status = "unknown";
        await ctx.journal.save(journal, this.stamp());
      }
      let extra: Partial<GistOperation> = {};
      if (input.action === "dismiss") await this.dismiss(ctx, journal, input.acceptDuplicateRisk);
      else if (input.action === "adopt") extra = await this.adopt(ctx, journal, input.gistId);
      else extra = await this.reconcile(ctx, journal, input.action === "finish");
      const status = await this.statusFor(ctx, journal.localId).catch(() => undefined);
      return { operation: this.summarize(journal, extra), ...(status ? { status } : {}) };
    });
  }

  private async dismiss(ctx: Context, journal: PublishJournal, acceptDuplicateRisk: boolean) {
    if (!UNRESOLVED.includes(journal.status)) return;
    if (this.inflight.has(journal.id)) throw new Error("This publication is still in progress.");
    if (
      journal.status === "unknown" &&
      journal.kind === "new" &&
      !journal.gist &&
      !acceptDuplicateRisk
    )
      throw new Error(
        "GitHub may already have created this Gist. Closing it can lead to a duplicate if you publish again. Confirm to close anyway.",
      );
    journal.status = "dismissed";
    await ctx.journal.save(journal, this.stamp());
  }

  private isConfirmed(journal: PublishJournal, doc: GistDocument) {
    const file = doc.files.find((f) => f.name === journal.fileName);
    return !!file && fileHash(file.text) === journal.payload.hash;
  }

  /** Observe GitHub (read-only) and move the record forward; `finish` also completes work. */
  private async reconcile(
    ctx: Context,
    journal: PublishJournal,
    finish: boolean,
  ): Promise<Partial<GistOperation>> {
    if (!UNRESOLVED.includes(journal.status)) return {};
    if (this.inflight.has(journal.id)) return {};
    if (journal.status === "remote-confirmed") {
      if (finish) await this.finishLocal(ctx, journal);
      return {};
    }
    if (journal.kind === "new" && !journal.gist) {
      // Zero matches does not prove nothing was created; several need a person to choose.
      return { candidates: await this.findCandidates(journal) };
    }
    const gist = journal.gist as NonNullable<PublishJournal["gist"]>;
    const doc = await this.gateway.read(gist.id, journal.fileName);
    const file = doc.files.find((f) => f.name === journal.fileName);
    const matches = this.isConfirmed(journal, doc);
    const evidence = {
      ...(file ? { remoteFileHash: fileHash(file.text) } : {}),
      expectedFileHash: journal.payload.hash,
      ...(doc.revision ? { remoteRevision: doc.revision } : {}),
      ...(doc.updatedAt ? { remoteUpdatedAt: doc.updatedAt } : {}),
      matches,
    };
    if (matches) {
      journal.status = "remote-confirmed";
      journal.revision = doc.revision;
      journal.confirmedBy = "content-match";
      delete journal.error;
      await ctx.journal.save(journal, this.stamp());
      await this.finishLocal(ctx, journal).catch(async (error) => {
        journal.error = errorText(error);
        await ctx.journal.save(journal, this.stamp()).catch(() => {});
      });
    } else if (finish && journal.status === "created" && journal.step === "embed") {
      await this.runEmbed(ctx, journal);
      if ((journal.status as string) === "remote-confirmed")
        await this.finishLocal(ctx, journal).catch(async (error) => {
          journal.error = errorText(error);
          await ctx.journal.save(journal, this.stamp()).catch(() => {});
        });
    }
    return { evidence: { ...evidence, matches: journal.status === "complete" || matches } };
  }

  private async candidateOk(journal: PublishJournal, doc: GistDocument) {
    if (doc.owner.id !== journal.account.id) return false;
    const file = doc.files.find((f) => f.name === journal.fileName);
    if (!file) return false;
    const hashes = [journal.firstText?.hash, journal.payload.hash].filter(Boolean);
    if (!hashes.includes(fileHash(file.text))) return false;
    const parsed = parseRemote(file.text);
    return parsed.hasIdentity && parsed.set?.id === journal.packId;
  }

  private async findCandidates(journal: PublishJournal) {
    if (!this.gateway.recent) return [];
    const since = Date.parse(journal.createdAt) - CANDIDATE_WINDOW_MS;
    const recent = (await this.gateway.recent({ limit: 30 }))
      .filter((g) => !g.updatedAt || Date.parse(g.updatedAt) >= since)
      .slice(0, 10);
    const found: { gistId: string; url: string; updatedAt?: string }[] = [];
    for (const item of recent) {
      const doc = await this.gateway.read(item.id, journal.fileName).catch(() => undefined);
      if (doc && (await this.candidateOk(journal, doc)))
        found.push({
          gistId: doc.id.toLowerCase(),
          url: doc.url,
          ...(doc.updatedAt ? { updatedAt: doc.updatedAt } : {}),
        });
    }
    return found;
  }

  private async adopt(
    ctx: Context,
    journal: PublishJournal,
    gistId?: string,
  ): Promise<Partial<GistOperation>> {
    if (journal.kind !== "new" || journal.gist || journal.status !== "unknown")
      throw new Error("There is nothing to adopt for this publication.");
    if (!gistId) throw new Error("Choose the Gist to adopt.");
    const doc = await this.gateway.read(gistId, journal.fileName);
    if (!(await this.candidateOk(journal, doc)))
      throw new Error("That Gist does not exactly match this publication.");
    journal.gist = {
      id: doc.id.toLowerCase(),
      url: doc.url,
      public: doc.public,
      ownerId: doc.owner.id,
      ownerLogin: doc.owner.login,
      ...(doc.revision ? { revision: doc.revision } : {}),
    };
    if (journal.storage === "portable") {
      const parsed = parseSet(journal.firstText?.text ?? "").set;
      const text = serializeSet(withGist(parsed, { id: journal.gist.id, file: journal.fileName }));
      journal.payload = { text, hash: fileHash(text), contentHash: journal.payload.contentHash };
      journal.step = "embed";
    }
    journal.confirmedBy = "adopted";
    if (this.isConfirmed(journal, doc)) {
      journal.status = "remote-confirmed";
      journal.revision = doc.revision;
      await ctx.journal.save(journal, this.stamp());
      await this.finishLocal(ctx, journal);
    } else {
      journal.status = "created";
      journal.error = "Adopted an existing Gist; the link inside it is still to be finished.";
      await ctx.journal.save(journal, this.stamp());
    }
    return {};
  }
}
