// A stateful model of the parts of GitHub's Gist REST API that profile publication relies on.
// It is deliberately independent of the plugin code, self-contained (no relative imports), and
// JSON-serializable so the same model can back an in-process fake and a fake `gh` executable.
import { createHash } from "node:crypto";

export interface FakeUser {
  id: number;
  login: string;
}
export interface FakeGistFile {
  content: string;
  /** GitHub sets this for files whose content it could not return in full. */
  truncated?: boolean;
}
export interface FakeVersion {
  version: string;
  committedAt: string;
  files: Record<string, string>;
  user: FakeUser;
}
export interface FakeGist {
  id: string;
  owner: FakeUser;
  public: boolean;
  description: string;
  files: Record<string, FakeGistFile>;
  /** Newest first, like GitHub's `history`. */
  history: FakeVersion[];
  /** Simulates GitHub omitting files from a very large Gist and flagging the whole response. */
  responseTruncated?: boolean;
}
export interface FakeRequest {
  method: string;
  path: string;
  body?: unknown;
  hostname?: string;
  token?: string;
}
export type FaultEffect =
  | { kind: "error"; status?: number; message?: string; stderr?: string }
  | { kind: "hang" };
export interface FakeFault {
  /** Regular expression source matched against `METHOD /path`. */
  match: string;
  effect: FaultEffect;
  /** A lost response: the server applied the write before the client lost the connection. */
  applied?: boolean;
  /** How many matching requests the fault applies to. Defaults to one. */
  times?: number;
  /** Skip this many matching requests first. */
  skip?: number;
}
export interface FakeSideEffect {
  /** Matched against `METHOD /path` before the request is handled. */
  match: string;
  /** A concurrent writer edits the Gist file just before the matched request arrives. */
  edit: { gistId: string; file: string; content: string; as?: FakeUser };
  times?: number;
}
export interface FakeGitHubState {
  user: FakeUser;
  /** Alternative identities selectable through GH_TOKEN. */
  tokens: Record<string, FakeUser>;
  loggedOut: boolean;
  gists: Record<string, FakeGist>;
  faults: FakeFault[];
  sideEffects: FakeSideEffect[];
  requests: FakeRequest[];
  counter: number;
}
export type FakeOutcome = { kind: "response"; status: number; body: unknown } | { kind: "hang" };

export function createState(user: FakeUser = { id: 1001, login: "charles" }): FakeGitHubState {
  return {
    user,
    tokens: {},
    loggedOut: false,
    gists: {},
    faults: [],
    sideEffects: [],
    requests: [],
    counter: 0,
  };
}

const sha = (value: string, length: number) =>
  createHash("sha256").update(value).digest("hex").slice(0, length);
// Real time keeps "recent Gist" windows realistic; the counter keeps versions strictly ordered.
const clock = (state: FakeGitHubState) => new Date(Date.now() + state.counter).toISOString();

function snapshot(files: Record<string, FakeGistFile>): Record<string, string> {
  return Object.fromEntries(Object.entries(files).map(([name, file]) => [name, file.content]));
}

function nextVersion(state: FakeGitHubState, gist: FakeGist, user: FakeUser) {
  state.counter += 1;
  const previous = gist.history[0]?.version ?? "";
  gist.history.unshift({
    version: sha(`${previous}\n${JSON.stringify(snapshot(gist.files))}\n${state.counter}`, 40),
    committedAt: clock(state),
    files: snapshot(gist.files),
    user,
  });
}

export function seedGist(
  state: FakeGitHubState,
  input: {
    id?: string;
    owner?: FakeUser;
    public?: boolean;
    description?: string;
    files: Record<string, string>;
  },
): FakeGist {
  state.counter += 1;
  const owner = input.owner ?? state.user;
  const gist: FakeGist = {
    id: input.id ?? sha(`gist-${state.counter}`, 32),
    owner,
    public: input.public ?? false,
    description: input.description ?? "",
    files: Object.fromEntries(
      Object.entries(input.files).map(([name, content]) => [name, { content }]),
    ),
    history: [],
  };
  nextVersion(state, gist, owner);
  state.gists[gist.id] = gist;
  return gist;
}

/** A write by another party that GitHub records as a new revision when the content differs. */
export function remoteEdit(
  state: FakeGitHubState,
  gistId: string,
  file: string,
  content: string | null,
  as?: FakeUser,
): void {
  const gist = state.gists[gistId];
  if (!gist) throw new Error(`Unknown fake Gist ${gistId}`);
  const before = JSON.stringify(snapshot(gist.files));
  if (content === null) delete gist.files[file];
  else gist.files[file] = { content };
  if (JSON.stringify(snapshot(gist.files)) !== before) nextVersion(state, gist, as ?? gist.owner);
}

function render(gist: FakeGist, files: Record<string, FakeGistFile>) {
  return {
    id: gist.id,
    html_url: `https://gist.github.com/${gist.owner.login}/${gist.id}`,
    public: gist.public,
    description: gist.description,
    owner: { id: gist.owner.id, login: gist.owner.login },
    truncated: gist.responseTruncated === true,
    created_at: gist.history[gist.history.length - 1]?.committedAt,
    updated_at: gist.history[0]?.committedAt,
    files: Object.fromEntries(
      Object.keys(files)
        .sort()
        .map((name) => {
          const file = files[name] as FakeGistFile;
          return [
            name,
            {
              filename: name,
              size: Buffer.byteLength(file.content, "utf8"),
              truncated: file.truncated === true,
              content: file.content,
              type: "text/plain",
            },
          ];
        }),
    ),
    history: gist.history.map((entry) => ({
      version: entry.version,
      committed_at: entry.committedAt,
      user: { id: entry.user.id, login: entry.user.login },
    })),
  };
}

const error = (status: number, message: string): FakeOutcome => ({
  kind: "response",
  status,
  body: { message, documentation_url: "https://docs.github.com/rest" },
});

function identity(state: FakeGitHubState, token?: string): FakeUser | undefined {
  if (token) return state.tokens[token];
  return state.loggedOut ? undefined : state.user;
}

function applyWrite(
  state: FakeGitHubState,
  request: FakeRequest,
  user: FakeUser,
  segments: string[],
): FakeOutcome {
  const body = (request.body ?? {}) as {
    description?: unknown;
    public?: unknown;
    files?: Record<string, { content?: unknown; filename?: unknown } | null>;
  };
  if (request.method === "POST") {
    if (segments.length !== 1 || segments[0] !== "gists") return error(404, "Not Found");
    const entries = Object.entries(body.files ?? {});
    if (entries.length === 0) return error(422, "Invalid request. files are required");
    const files: Record<string, string> = {};
    for (const [name, value] of entries) {
      if (!value || typeof value.content !== "string" || value.content === "")
        return error(422, "Validation Failed: files.content is missing");
      files[name] = value.content;
    }
    const gist = seedGist(state, {
      owner: user,
      public: body.public === true,
      description: typeof body.description === "string" ? body.description : "",
      files,
    });
    return { kind: "response", status: 201, body: render(gist, gist.files) };
  }
  // PATCH /gists/:id
  const gist = state.gists[segments[1] ?? ""];
  if (!gist || gist.owner.id !== user.id) return error(404, "Not Found");
  const before = JSON.stringify([snapshot(gist.files), gist.description]);
  if (typeof body.description === "string") gist.description = body.description;
  for (const [name, value] of Object.entries(body.files ?? {})) {
    if (value === null) {
      delete gist.files[name];
      continue;
    }
    const current = gist.files[name];
    const content = typeof value.content === "string" ? value.content : current?.content;
    if (content === undefined || content === "")
      return error(422, "Validation Failed: files.content is missing");
    const target = typeof value.filename === "string" ? value.filename : name;
    if (target !== name) delete gist.files[name];
    gist.files[target] = { content };
  }
  if (Object.keys(gist.files).length === 0) return error(422, "Gist must have at least one file");
  // GitHub records a revision only when something actually changed.
  if (JSON.stringify([snapshot(gist.files), gist.description]) !== before)
    nextVersion(state, gist, user);
  return { kind: "response", status: 200, body: render(gist, gist.files) };
}

function route(state: FakeGitHubState, request: FakeRequest, user: FakeUser): FakeOutcome {
  const [pathname = "", query = ""] = request.path.replace(/^\/+/, "").split("?", 2);
  const params = new URLSearchParams(query);
  const segments = pathname.split("/").filter(Boolean);
  if (request.method === "GET" && segments.length === 1 && segments[0] === "user")
    return {
      kind: "response",
      status: 200,
      body: { id: user.id, login: user.login, type: "User" },
    };
  if (request.method === "GET" && segments.length === 1 && segments[0] === "gists")
    return {
      kind: "response",
      status: 200,
      body: Object.values(state.gists)
        .filter((gist) => gist.owner.id === user.id)
        .sort((a, b) =>
          (b.history[0]?.committedAt ?? "").localeCompare(a.history[0]?.committedAt ?? ""),
        )
        .slice(0, Math.min(100, Number(params.get("per_page")) || 30))
        .map((gist) => ({
          ...render(gist, gist.files),
          // The list endpoint never includes file contents.
          files: Object.fromEntries(
            Object.entries(gist.files).map(([name, file]) => [
              name,
              { filename: name, size: Buffer.byteLength(file.content, "utf8") },
            ]),
          ),
        })),
    };
  if (segments[0] !== "gists") return error(404, "Not Found");
  if (request.method === "GET" && segments.length === 2) {
    const gist = state.gists[segments[1] ?? ""];
    return gist
      ? { kind: "response", status: 200, body: render(gist, gist.files) }
      : error(404, "Not Found");
  }
  if (request.method === "GET" && segments.length === 3) {
    const gist = state.gists[segments[1] ?? ""];
    const version = gist?.history.find((entry) => entry.version === segments[2]);
    if (!gist || !version) return error(404, "Not Found");
    return {
      kind: "response",
      status: 200,
      body: render(
        { ...gist, history: gist.history.slice(gist.history.indexOf(version)) },
        Object.fromEntries(Object.entries(version.files).map(([n, content]) => [n, { content }])),
      ),
    };
  }
  if (request.method === "POST" || request.method === "PATCH")
    return applyWrite(state, request, user, segments);
  return error(404, "Not Found");
}

function matches(pattern: string, request: FakeRequest): boolean {
  return new RegExp(pattern).test(`${request.method} /${request.path.replace(/^\/+/, "")}`);
}

/** Handles one request against the model, applying scripted faults and concurrent edits. */
export function handleRequest(state: FakeGitHubState, request: FakeRequest): FakeOutcome {
  state.requests.push({
    method: request.method,
    path: request.path.replace(/^\/+/, ""),
    body: request.body,
    hostname: request.hostname,
  });
  if (request.hostname && request.hostname !== "github.com")
    return error(400, `fake gh only serves github.com, got ${request.hostname}`);
  for (const effect of state.sideEffects) {
    if (effect.times === 0 || !matches(effect.match, request)) continue;
    effect.times = (effect.times ?? 1) - 1;
    remoteEdit(state, effect.edit.gistId, effect.edit.file, effect.edit.content, effect.edit.as);
  }
  const user = identity(state, request.token);
  if (!user) return error(401, "Bad credentials");
  const fault = state.faults.find((item) => (item.times ?? 1) > 0 && matches(item.match, request));
  if (fault && (fault.skip ?? 0) > 0) {
    fault.skip = (fault.skip ?? 0) - 1;
  } else if (fault) {
    fault.times = (fault.times ?? 1) - 1;
    if (fault.applied) route(state, request, user);
    return fault.effect.kind === "hang"
      ? { kind: "hang" }
      : {
          kind: "response",
          status: fault.effect.status ?? 0,
          body: { message: fault.effect.message ?? "", stderr: fault.effect.stderr },
        };
  }
  return route(state, request, user);
}

export const gistOf = (state: FakeGitHubState, id: string): FakeGist => {
  const gist = state.gists[id];
  if (!gist) throw new Error(`Unknown fake Gist ${id}`);
  return gist;
};
