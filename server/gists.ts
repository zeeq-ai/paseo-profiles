import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import type { RpcInput } from "@getpaseo/plugin";
import type * as contracts from "../shared/rpc";
import { LIMITS } from "../shared/set";

const MAX_API_OUTPUT = LIMITS.bytes * LIMITS.files + 1_000_000;
const MAX_STDERR = 16_000;
const GITHUB_HOST = "github.com";
const API_VERSION = "2026-03-10";

export interface GistAccount {
  id: number;
  login: string;
}

export interface GistDocument {
  id: string;
  url: string;
  owner: GistAccount;
  public: boolean;
  files: { name: string; text: string }[];
  /** Total Gist files, including files omitted by a selected-file read. */
  fileCount?: number;
  /** GitHub's reported head; it does not prove which writer produced it. */
  revision?: string;
  updatedAt?: string;
}

export interface GistGateway {
  account(): Promise<GistAccount>;
  /** A selected-file read validates only that file's contents and returns only that file. */
  read(gistId: string, fileName?: string): Promise<GistDocument>;
  create(input: {
    files: { name: string; text: string }[];
    description: string;
    public: boolean;
  }): Promise<GistDocument>;
  update(input: { gistId: string; fileName: string; text: string }): Promise<GistDocument>;
  recent?(input: { limit: number }): Promise<{ id: string; url: string; updatedAt?: string }[]>;
}

export class GistTransportError extends Error {
  readonly kind:
    | "unavailable"
    | "invalid-input"
    | "timeout"
    | "lost-response"
    | "http"
    | "invalid-response";
  readonly requestSent: boolean;
  readonly status?: number;

  constructor(
    kind: GistTransportError["kind"],
    message: string,
    options: { requestSent: boolean; status?: number },
  ) {
    super(message);
    this.name = "GistTransportError";
    this.kind = kind;
    this.requestSent = options.requestSent;
    this.status = options.status;
  }
}

export function isWriteOutcomeUnknown(error: unknown): boolean {
  if (!(error instanceof GistTransportError)) return true;
  if (!error.requestSent) return false;
  return error.status === undefined || error.status >= 500 || error.status === 408;
}

function cleanMessage(value: string): string {
  const printable = Array.from(value)
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code >= 32 && code !== 127;
    })
    .join("");
  return printable.replace(/\s+/g, " ").trim().slice(0, 600);
}

function commandFailure(stderr: string, code: number | null): GistTransportError {
  const detail = cleanMessage(stderr);
  const status = Number(detail.match(/\bHTTP\s+(\d{3})\b/i)?.[1]) || undefined;
  if (
    /\b401\b|bad credentials|not logged in|authentication required|run.*gh auth login/i.test(detail)
  )
    return new GistTransportError(
      "http",
      "GitHub CLI is not authenticated for GitHub.com on this Paseo host. Run `gh auth login` on that host and try again.",
      { requestSent: true, status: status ?? 401 },
    );
  return new GistTransportError(
    status ? "http" : "lost-response",
    detail
      ? `GitHub CLI failed${code === null ? "" : ` (exit ${code})`}: ${detail}`
      : `GitHub CLI failed${code === null ? "" : ` (exit ${code})`}. Check gh auth status on this Paseo host.`,
    { requestSent: true, status },
  );
}

export type GhRunner = (
  args: string[],
  input?: string,
  maxOutput?: number,
  timeoutMs?: number,
) => Promise<string>;

function requestTimeout(): number {
  const configured = Number(process.env.PASEO_PROFILES_GH_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : 60_000;
}

export function runGh(
  args: string[],
  input?: string,
  maxOutput = MAX_API_OUTPUT,
  timeoutMs = requestTimeout(),
): Promise<string> {
  return new Promise((resolve, reject) => {
    const methodIndex = args.indexOf("--method");
    const mutative =
      methodIndex >= 0 && /^(POST|PATCH|PUT|DELETE)$/i.test(args[methodIndex + 1] ?? "");
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("gh", args, {
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          GH_PROMPT_DISABLED: "1",
          GIT_TERMINAL_PROMPT: "0",
        },
      });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      reject(
        code === "ENOENT"
          ? new GistTransportError(
              "unavailable",
              "GitHub CLI (`gh`) is not installed or is not on this Paseo host's PATH.",
              { requestSent: false },
            )
          : new GistTransportError(
              "unavailable",
              `Could not start GitHub CLI: ${cleanMessage(String(error))}`,
              { requestSent: false },
            ),
      );
      return;
    }

    const output: Buffer[] = [];
    let outputBytes = 0;
    let stderr = "";
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;

    const finish = (error?: Error, text?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(text ?? "");
    };

    timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(
        new GistTransportError(
          "timeout",
          mutative
            ? "GitHub CLI timed out. A sent write may have completed; check its result before publishing again."
            : "GitHub CLI timed out. Check the network connection and try checking again.",
          { requestSent: true },
        ),
      );
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > maxOutput) {
        child.kill("SIGTERM");
        finish(
          new GistTransportError(
            "lost-response",
            mutative
              ? "Gist contents exceed the supported transfer size. A sent write may have completed."
              : "Gist contents exceed the supported transfer size.",
            { requestSent: true },
          ),
        );
        return;
      }
      output.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_STDERR) stderr += chunk.toString("utf8");
    });
    child.stdin?.on("error", () => {});
    child.on("error", (error: NodeJS.ErrnoException) => {
      finish(
        error.code === "ENOENT"
          ? new GistTransportError(
              "unavailable",
              "GitHub CLI (`gh`) is not installed or is not on this Paseo host's PATH.",
              { requestSent: false },
            )
          : new GistTransportError(
              "unavailable",
              `Could not start GitHub CLI: ${cleanMessage(error.message)}`,
              { requestSent: false },
            ),
      );
    });
    child.on("close", (code) => {
      if (code === 0) finish(undefined, Buffer.concat(output).toString("utf8"));
      else finish(commandFailure(stderr, code));
    });
    child.stdin?.end(input ?? "", "utf8");
  });
}

export function safeGistFilename(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= 255 &&
    name !== "." &&
    name !== ".." &&
    !name.includes("/") &&
    !name.includes("\\") &&
    Array.from(name).every((character) => {
      const code = character.charCodeAt(0);
      return code >= 32 && code !== 127;
    })
  );
}

function validateGistFiles(files: { name: string; text: string }[]): void {
  if (files.length === 0) throw new Error("Select at least one profile pack.");
  if (files.length > LIMITS.files)
    throw new Error(`A gist can contain at most ${LIMITS.files} profile-pack files.`);
  const names = new Set<string>();
  let totalBytes = 0;
  for (const file of files) {
    if (!safeGistFilename(file.name)) throw new Error("A gist filename is not supported.");
    if (names.has(file.name)) throw new Error("Gist filenames must be unique.");
    names.add(file.name);
    const size = Buffer.byteLength(file.text, "utf8");
    if (size > LIMITS.bytes)
      throw new Error(`${file.name} exceeds the ${LIMITS.bytes}-byte limit.`);
    totalBytes += size;
  }
  if (totalBytes > LIMITS.bytes * LIMITS.files)
    throw new Error("Gist contents exceed the supported transfer size.");
}

export async function gistAvailability() {
  try {
    await runGh(["--version"], undefined, 8_000, 5_000);
    return { available: true };
  } catch (error) {
    return {
      available: false,
      message: error instanceof Error ? error.message : "Could not check GitHub CLI availability.",
    };
  }
}

export async function createGist(input: RpcInput<typeof contracts.createGist>) {
  const result = await ghGistGateway.create({
    files: input.files,
    description: "Paseo agent profile packs",
    public: false,
  });
  return { url: result.url };
}

export function gistIdFromUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Enter a full HTTPS GitHub Gist URL.");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname.toLowerCase() !== "gist.github.com" ||
    url.username ||
    url.password ||
    url.port
  )
    throw new Error("Only HTTPS URLs from gist.github.com are supported.");
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 1 || parts.length > 2)
    throw new Error("Enter a GitHub Gist URL, not a raw file URL.");
  const id = parts[parts.length - 1].replace(/\.git$/i, "");
  if (!/^[a-f0-9]{5,64}$/i.test(id))
    throw new Error("The Gist URL does not contain a valid Gist ID.");
  return id.toLowerCase();
}

export async function readGist(input: RpcInput<typeof contracts.readGist>) {
  const selected = input.fileName;
  if (selected && (!safeGistFilename(selected) || !/\.(yaml|yml|json)$/i.test(selected)))
    throw new Error("Choose a YAML or JSON profile-pack file.");
  const result = await ghGistGateway.read(gistIdFromUrl(input.url), selected);
  const files = result.files.filter(
    (file) => /\.(yaml|yml|json)$/i.test(file.name) && (!selected || file.name === selected),
  );
  if (files.length === 0) throw new Error("No YAML or JSON profile files were found in this Gist.");
  if (files.length > LIMITS.files)
    throw new Error(`This Gist has more than ${LIMITS.files} supported profile files.`);
  validateGistFiles(files);
  return { files };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function responseAccount(value: unknown): GistAccount {
  const item = record(value);
  if (
    !item ||
    !Number.isSafeInteger(item.id) ||
    Number(item.id) <= 0 ||
    typeof item.login !== "string" ||
    !item.login.trim()
  )
    throw new Error("GitHub returned an invalid account identity.");
  return { id: Number(item.id), login: item.login };
}

function responseGist(value: unknown, selectedFile?: string): GistDocument {
  const item = record(value);
  if (!item || typeof item.id !== "string" || !/^[a-f0-9]{5,64}$/i.test(item.id))
    throw new Error("GitHub returned an invalid Gist identity.");
  const id = item.id.toLowerCase();
  if (typeof item.html_url !== "string" || gistIdFromUrl(item.html_url) !== id)
    throw new Error("GitHub returned an invalid Gist URL.");
  if (item.truncated === true) throw new Error("GitHub returned a truncated Gist file list.");
  const contents = record(item.files);
  if (!contents || typeof item.public !== "boolean")
    throw new Error("GitHub returned an invalid Gist response.");
  const files: GistDocument["files"] = [];
  const entries = Object.entries(contents);
  for (const [name, value] of entries) {
    if (selectedFile !== undefined && name !== selectedFile) continue;
    const file = record(value);
    if (!safeGistFilename(name) || !file) throw new Error("A Gist filename is not supported.");
    if (file.truncated === true)
      throw new Error(`${name} is too large for GitHub's Gist content response.`);
    if (typeof file.content !== "string") throw new Error(`${name} has no text content.`);
    if (Buffer.byteLength(file.content, "utf8") > LIMITS.bytes)
      throw new Error(`${name} exceeds the ${LIMITS.bytes}-byte limit.`);
    files.push({ name, text: file.content });
  }
  const firstHistory = Array.isArray(item.history) ? record(item.history[0]) : undefined;
  const revision =
    typeof firstHistory?.version === "string" && /^[a-f0-9]{40,64}$/i.test(firstHistory.version)
      ? firstHistory.version
      : undefined;
  return {
    id,
    url: `https://gist.github.com/${id}`,
    owner: responseAccount(item.owner),
    public: item.public,
    files,
    fileCount: entries.length,
    ...(revision ? { revision } : {}),
    ...(typeof item.updated_at === "string" ? { updatedAt: item.updated_at } : {}),
  };
}

function validatedGistId(gistId: string): string {
  if (!/^[a-f0-9]{5,64}$/i.test(gistId))
    throw new GistTransportError("invalid-input", "Invalid Gist ID.", { requestSent: false });
  return gistId.toLowerCase();
}

function validateOutgoingFiles(files: { name: string; text: string }[]): void {
  try {
    validateGistFiles(files);
  } catch (error) {
    throw new GistTransportError(
      "invalid-input",
      error instanceof Error ? error.message : "Invalid Gist files.",
      { requestSent: false },
    );
  }
}

export function createGhGistGateway(runner: GhRunner = runGh): GistGateway {
  const request = async (method: "GET" | "POST" | "PATCH", endpoint: string, body?: unknown) => {
    const args = [
      "api",
      endpoint,
      "--hostname",
      GITHUB_HOST,
      "--method",
      method,
      "-H",
      "Accept: application/vnd.github+json",
      "-H",
      `X-GitHub-Api-Version: ${API_VERSION}`,
    ];
    if (body !== undefined) args.push("--input", "-");
    const output = await runner(args, body === undefined ? undefined : JSON.stringify(body));
    try {
      return JSON.parse(output) as unknown;
    } catch {
      throw new GistTransportError(
        "invalid-response",
        method === "GET"
          ? "GitHub returned an unreadable response."
          : "GitHub returned an unreadable response. A sent write may have completed; check its result before publishing again.",
        { requestSent: true },
      );
    }
  };
  const gistRequest = async (
    method: "GET" | "POST" | "PATCH",
    endpoint: string,
    body?: unknown,
    selectedFile?: string,
  ) => {
    const value = await request(method, endpoint, body);
    try {
      return responseGist(value, selectedFile);
    } catch (error) {
      throw new GistTransportError(
        "invalid-response",
        error instanceof Error ? error.message : "GitHub returned an invalid Gist response.",
        { requestSent: true },
      );
    }
  };
  return {
    async account() {
      return responseAccount(await request("GET", "user"));
    },
    async read(gistId, fileName) {
      if (fileName !== undefined && !safeGistFilename(fileName))
        throw new GistTransportError("invalid-input", "A Gist filename is not supported.", {
          requestSent: false,
        });
      return gistRequest("GET", `gists/${validatedGistId(gistId)}`, undefined, fileName);
    },
    async create(input) {
      validateOutgoingFiles(input.files);
      return gistRequest("POST", "gists", {
        description: input.description,
        public: input.public,
        files: Object.fromEntries(input.files.map(({ name, text }) => [name, { content: text }])),
      });
    },
    async update(input) {
      validateOutgoingFiles([{ name: input.fileName, text: input.text }]);
      return gistRequest(
        "PATCH",
        `gists/${validatedGistId(input.gistId)}`,
        { files: { [input.fileName]: { content: input.text } } },
        input.fileName,
      );
    },
    async recent(input) {
      const limit = Number.isFinite(input.limit)
        ? Math.max(1, Math.min(100, Math.floor(input.limit)))
        : 30;
      const result = await request("GET", `gists?per_page=${limit}`);
      if (!Array.isArray(result))
        throw new GistTransportError("invalid-response", "GitHub returned an invalid Gist list.", {
          requestSent: true,
        });
      return result.slice(0, limit).map((value) => {
        const item = record(value);
        if (!item || typeof item.id !== "string")
          throw new GistTransportError(
            "invalid-response",
            "GitHub returned an invalid Gist identity.",
            { requestSent: true },
          );
        const id = validatedGistId(item.id);
        return {
          id,
          url: `https://gist.github.com/${id}`,
          ...(typeof item.updated_at === "string" ? { updatedAt: item.updated_at } : {}),
        };
      });
    },
  };
}

export const ghGistGateway = createGhGistGateway();
