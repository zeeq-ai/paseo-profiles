import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createState,
  type FakeFault,
  type FakeGist,
  type FakeGitHubState,
  type FakeRequest,
  type FakeSideEffect,
  type FakeUser,
  gistOf,
  remoteEdit,
  seedGist,
} from "./fake-github";

const MODEL_URL = new URL("./fake-github.ts", import.meta.url).href;

// The executable runs under the same Node binary as the tests, so it can import the TypeScript
// model directly. State lives in one JSON file shared by every `gh` invocation.
function script(stateFile: string): string {
  return `#!${process.execPath}
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const STATE = ${JSON.stringify(stateFile)};
const LOCK = STATE + ".lock";

function fail(stderr, code = 1) {
  process.stderr.write(stderr.endsWith("\\n") ? stderr : stderr + "\\n");
  process.exit(code);
}
function option(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}
async function main() {
  const args = process.argv.slice(2);
  if (args[0] === "--version") return void process.stdout.write("gh version 2.99.0 (fake)\\n");
  if (args[0] !== "api") fail("fake gh supports only 'api' and '--version': " + args.join(" "));
  const endpoint = args[1];
  const input = option(args, "--input");
  const explicitMethod = option(args, "--method") || option(args, "-X");
  const method = (explicitMethod || (input ? "POST" : "GET")).toUpperCase();
  const hostname = option(args, "--hostname");
  const jq = option(args, "--jq");
  let body;
  if (input === "-") {
    const text = fs.readFileSync(0, "utf8");
    if (text) body = JSON.parse(text);
  }
  const model = await import(${JSON.stringify(MODEL_URL)});
  for (let attempt = 0; ; attempt += 1) {
    try { fs.mkdirSync(LOCK); break; }
    catch (error) {
      if (error.code !== "EEXIST" || attempt > 200) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  let outcome;
  try {
    const state = JSON.parse(fs.readFileSync(STATE, "utf8"));
    outcome = model.handleRequest(state, {
      method, path: endpoint, body, hostname, token: process.env.GH_TOKEN || undefined,
    });
    fs.writeFileSync(STATE, JSON.stringify(state));
  } finally {
    fs.rmdirSync(LOCK);
  }
  if (outcome.kind === "hang") { setInterval(() => {}, 1000); return; }
  const { status, body: payload } = outcome;
  if (status === 0) fail(payload.stderr || 'gh: Post "https://api.github.com/gists": read tcp 127.0.0.1:50000->140.82.112.5:443: connection reset by peer');
  if (status >= 400) {
    process.stdout.write(JSON.stringify(payload) + "\\n");
    fail("gh: " + (payload.message || "Error") + " (HTTP " + status + ")");
  }
  let text = JSON.stringify(payload);
  if (jq) {
    const result = spawnSync("jq", ["-c", jq], { input: text, encoding: "utf8" });
    if (result.status !== 0) fail("jq failed: " + result.stderr);
    text = result.stdout.trimEnd();
  }
  process.stdout.write(text + "\\n");
}
main().catch((error) => fail("fake gh crashed: " + (error && error.stack || error)));
`;
}

export interface FakeGh {
  /** Directory holding the fake `gh`; put it first on PATH. */
  readonly binDir: string;
  /** JSON state shared by every `gh` call; tools may edit it between calls. */
  readonly stateFile: string;
  /** Environment overrides for a process that must reach the fake instead of real GitHub. */
  readonly env: { PATH: string };
  state(): Promise<FakeGitHubState>;
  /** Mutates the model between invocations. */
  mutate<T>(action: (state: FakeGitHubState) => T): Promise<T>;
  seed(input: Parameters<typeof seedGist>[1]): Promise<FakeGist>;
  gist(id: string): Promise<FakeGist>;
  /** A concurrent party edits a bound file now. */
  edit(gistId: string, file: string, content: string | null, as?: FakeUser): Promise<void>;
  fault(fault: FakeFault): Promise<void>;
  sideEffect(effect: FakeSideEffect): Promise<void>;
  requests(): Promise<FakeRequest[]>;
  /** Only requests that changed GitHub state. */
  writes(): Promise<FakeRequest[]>;
  clearRequests(): Promise<void>;
  dispose(): Promise<void>;
}

export async function createFakeGh(user?: FakeUser): Promise<FakeGh> {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-profiles-fake-gh-"));
  const binDir = path.join(root, "bin");
  const stateFile = path.join(root, "state.json");
  await mkdir(binDir);
  await writeFile(stateFile, JSON.stringify(createState(user)));
  await writeFile(path.join(binDir, "gh"), script(stateFile), { mode: 0o755 });
  await chmod(path.join(binDir, "gh"), 0o755);

  const load = async () => JSON.parse(await readFile(stateFile, "utf8")) as FakeGitHubState;
  const mutate = async <T>(action: (state: FakeGitHubState) => T): Promise<T> => {
    const state = await load();
    const result = action(state);
    await writeFile(stateFile, JSON.stringify(state));
    return result;
  };
  return {
    binDir,
    stateFile,
    env: { PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}` },
    state: load,
    mutate,
    seed: (input) => mutate((state) => seedGist(state, input)),
    gist: async (id) => gistOf(await load(), id),
    edit: (gistId, file, content, as) =>
      mutate((state) => remoteEdit(state, gistId, file, content, as)),
    fault: (fault) =>
      mutate((state) => {
        state.faults.push(fault);
      }),
    sideEffect: (effect) =>
      mutate((state) => {
        state.sideEffects.push(effect);
      }),
    requests: async () => (await load()).requests,
    writes: async () => (await load()).requests.filter((r) => r.method !== "GET"),
    clearRequests: () =>
      mutate((state) => {
        state.requests = [];
      }),
    dispose: () => rm(root, { recursive: true, force: true }),
  };
}
