import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { vi } from "vitest";
import type { Fault } from "../../server/files";
import { GistLinkStore } from "../../server/gist-link-store";
import { GistPublicationService } from "../../server/gist-publication";
import type { GistGateway } from "../../server/gists";
import { LibraryStore } from "../../server/library-store";
import { serializeSet } from "../../server/yaml";
import type { HostLinkRecord } from "../../shared/gist";
import type { LibraryEntry, ProfileSet } from "../../shared/set";
import { createFakeGh, type FakeGh } from "./fake-gh";
import type { FakeUser } from "./fake-github";

const run = promisify(execFile);

export interface PublicationFixture {
  home: string;
  store: LibraryStore;
  links: GistLinkStore;
  gh: FakeGh;
  service: GistPublicationService;
  /** Saves a pack into the library and returns its entry. */
  save(set: ProfileSet, localId?: string, expectedRevision?: string): Promise<LibraryEntry>;
  /** Writes a host link record directly, as if a previous session had saved it. */
  writeHostRecord(
    record: Partial<HostLinkRecord> & Pick<HostLinkRecord, "localId" | "packId">,
  ): Promise<void>;
  /** A fresh empty Git working tree on this host. */
  gitRepository(): Promise<string>;
  /** Names of every file under the Paseo home (relative), for leak assertions. */
  filesUnderHome(): Promise<string[]>;
  /** A new service over the same library, as after a plugin restart. */
  restart(options?: { fault?: Fault; gateway?: GistGateway }): GistPublicationService;
  dispose(): Promise<void>;
}

async function walk(directory: string, base = directory): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await walk(full, base)));
    else found.push(path.relative(base, full));
  }
  return found;
}

/**
 * The real publication service and real `gh` transport over a temp library, talking to a
 * stateful fake GitHub through a fake `gh` first on PATH. Nothing can reach GitHub.
 */
export async function createPublicationFixture(
  options: { user?: FakeUser; fault?: Fault; gateway?: GistGateway } = {},
): Promise<PublicationFixture> {
  const home = await mkdtemp(path.join(tmpdir(), "paseo-profiles-publication-"));
  const gh = await createFakeGh(options.user);
  vi.stubEnv("PATH", gh.env.PATH);
  vi.stubEnv("GH_TOKEN", "");
  const store = new LibraryStore({ home, fault: options.fault });
  await store.initialize();
  const links = new GistLinkStore(store);
  const make = (overrides: { fault?: Fault; gateway?: GistGateway } = {}) =>
    new GistPublicationService({
      store: async () => store,
      fault: overrides.fault ?? options.fault,
      gateway: overrides.gateway ?? options.gateway,
    });
  const repositories: string[] = [];
  return {
    home,
    store,
    links,
    gh,
    service: make(),
    save: (set, localId, expectedRevision) => store.save(set, localId, expectedRevision),
    writeHostRecord: (record) =>
      links.write({
        format: "paseo-profile-gist-host-link",
        version: 1,
        storage: "host",
        previous: [],
        ...record,
      } as HostLinkRecord),
    async gitRepository() {
      const directory = await mkdtemp(path.join(tmpdir(), "paseo-profiles-repo-"));
      repositories.push(directory);
      await run("git", ["init", "--quiet", directory]);
      return await import("node:fs/promises").then((fs) => fs.realpath(directory));
    },
    filesUnderHome: () => walk(home),
    restart: (overrides) => make(overrides),
    async dispose() {
      vi.unstubAllEnvs();
      await gh.dispose();
      await rm(home, { recursive: true, force: true });
      await Promise.all(repositories.map((r) => rm(r, { recursive: true, force: true })));
    },
  };
}

export const packText = (set: ProfileSet) => serializeSet(set);
export async function readText(file: string) {
  return readFile(file, "utf8");
}
export async function ensureDirectory(directory: string) {
  await mkdir(directory, { recursive: true });
}

// ---- scenario helpers over the service's RPC-shaped methods ----------------------------------

type Service = GistPublicationService;
export type LinkOptions = {
  gistId: string;
  fileName: string;
  storage?: "host" | "repository" | "portable";
  repository?: string;
};
export type NewOptions = {
  storage?: "host" | "repository" | "portable";
  repository?: string;
  fileName?: string;
  public?: boolean;
  description?: string;
};
export type CommitOptions = {
  overwriteRemote?: boolean;
  confirmTarget?: boolean;
  refreshBaselineOnly?: boolean;
};

export function scenario(f: PublicationFixture, service: () => Service = () => f.service) {
  const current = (localId: string) => f.store.read(localId);
  return {
    current,
    async linkPreview(localId: string, options: LinkOptions) {
      const entry = await current(localId);
      return service().linkPreview({
        libraryRoot: "",
        localId,
        expectedRevision: entry.revision,
        gistId: options.gistId,
        fileName: options.fileName,
        storage: options.storage ?? "host",
        repository: options.repository,
      });
    },
    /** Preview and confirm in one step, as a person approving the review would. */
    async link(localId: string, options: LinkOptions) {
      const preview = await this.linkPreview(localId, options);
      const result = await service().linkCommit({
        libraryRoot: "",
        previewId: preview.previewId,
        confirmTarget: true,
      });
      return { preview, ...result };
    },
    async unlink(localId: string) {
      const entry = await current(localId);
      return service().unlink({ libraryRoot: "", localId, expectedRevision: entry.revision });
    },
    async previewRevision(localId: string) {
      const entry = await current(localId);
      return service().publishPreview({
        libraryRoot: "",
        localId,
        expectedRevision: entry.revision,
        mode: "revision",
        public: false,
      });
    },
    async previewNew(localId: string, options: NewOptions = {}) {
      const entry = await current(localId);
      return service().publishPreview({
        libraryRoot: "",
        localId,
        expectedRevision: entry.revision,
        mode: "new",
        storage: options.storage,
        repository: options.repository,
        fileName: options.fileName,
        public: options.public ?? false,
        description: options.description,
      });
    },
    commit(previewId: string, options: CommitOptions = {}) {
      return service().publishCommit({
        libraryRoot: "",
        previewId,
        overwriteRemote: options.overwriteRemote ?? false,
        confirmTarget: options.confirmTarget ?? false,
        refreshBaselineOnly: options.refreshBaselineOnly ?? false,
      });
    },
    operation(
      operationId: string,
      action: "check" | "finish" | "adopt" | "dismiss" = "check",
      extra: { gistId?: string; acceptDuplicateRisk?: boolean } = {},
    ) {
      return service().publishOperation({
        libraryRoot: "",
        operationId,
        action,
        acceptDuplicateRisk: extra.acceptDuplicateRisk ?? false,
        gistId: extra.gistId,
      });
    },
    async status(localId: string, check = false) {
      return (await service().status({ libraryRoot: "", localIds: [localId], check })).statuses[0];
    },
  };
}
