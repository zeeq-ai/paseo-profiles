import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import type { RpcInput } from "@getpaseo/plugin";
import type * as contracts from "../shared/rpc";
import { LIMITS } from "../shared/set";

const MAX_API_OUTPUT = LIMITS.bytes * LIMITS.files + 1_000_000;
const MAX_STDERR = 16_000;
const GITHUB_HOST = "github.com";

class GhCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GhCliError";
  }
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

function commandFailure(stderr: string, code: number | null): GhCliError {
  const detail = cleanMessage(stderr);
  if (
    /\b401\b|bad credentials|not logged in|authentication required|run.*gh auth login/i.test(detail)
  )
    return new GhCliError(
      "GitHub CLI is not authenticated for GitHub.com on this Paseo host. Run `gh auth login` on that host and try again.",
    );
  return new GhCliError(
    detail
      ? `GitHub CLI failed${code === null ? "" : ` (exit ${code})`}: ${detail}`
      : `GitHub CLI failed${code === null ? "" : ` (exit ${code})`}. Check gh auth status on this Paseo host and try again.`,
  );
}

function runGh(
  args: string[],
  input?: string,
  maxOutput = MAX_API_OUTPUT,
  timeoutMs = 60_000,
): Promise<string> {
  return new Promise((resolve, reject) => {
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
          ? new GhCliError(
              "GitHub CLI (`gh`) is not installed or is not on this Paseo host's PATH.",
            )
          : new GhCliError(`Could not start GitHub CLI: ${cleanMessage(String(error))}`),
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
      finish(new GhCliError("GitHub CLI timed out. Check the network connection and try again."));
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > maxOutput) {
        child.kill("SIGTERM");
        finish(new GhCliError("Gist contents exceed the supported transfer size."));
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
          ? new GhCliError(
              "GitHub CLI (`gh`) is not installed or is not on this Paseo host's PATH.",
            )
          : new GhCliError(`Could not start GitHub CLI: ${cleanMessage(error.message)}`),
      );
    });
    child.on("close", (code) => {
      if (code === 0) finish(undefined, Buffer.concat(output).toString("utf8"));
      else finish(commandFailure(stderr, code));
    });
    child.stdin?.end(input ?? "", "utf8");
  });
}

function safeGistFilename(name: string): boolean {
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
  validateGistFiles(input.files);
  const body = JSON.stringify({
    description: "Paseo agent profile packs",
    public: false,
    files: Object.fromEntries(input.files.map(({ name, text }) => [name, { content: text }])),
  });
  const output = await runGh(
    ["api", "gists", "--hostname", GITHUB_HOST, "--method", "POST", "--input", "-"],
    body,
  );
  let result: { html_url?: unknown };
  try {
    result = JSON.parse(output) as { html_url?: unknown };
  } catch {
    throw new Error(
      "GitHub created a gist but returned an unreadable response. Check `gh gist list`.",
    );
  }
  if (typeof result.html_url !== "string")
    throw new Error("GitHub created a gist but did not return its URL. Check `gh gist list`.");
  let url: URL;
  try {
    url = new URL(result.html_url);
  } catch {
    throw new Error("GitHub created a gist but returned an invalid URL. Check `gh gist list`.");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "gist.github.com" ||
    url.username ||
    url.password ||
    url.port
  )
    throw new Error("The configured GitHub host did not return a GitHub.com Gist URL.");
  return { url: url.toString() };
}

function gistIdFromUrl(value: string): string {
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
  const id = gistIdFromUrl(input.url);
  const output = await runGh([
    "api",
    `gists/${id}`,
    "--hostname",
    GITHUB_HOST,
    "--jq",
    '{files: [.files | to_entries[] | select(.key | test("\\\\.(yaml|yml|json)$"; "i")) | {name: .key, content: .value.content, truncated: .value.truncated}]}',
  ]);
  let result: { files?: unknown };
  try {
    result = JSON.parse(output) as { files?: unknown };
  } catch {
    throw new Error("GitHub returned an unreadable Gist response.");
  }
  if (!Array.isArray(result.files))
    throw new Error("The Gist does not contain readable profile files.");
  if (result.files.length === 0)
    throw new Error("No YAML or JSON profile files were found in this Gist.");
  if (result.files.length > LIMITS.files)
    throw new Error(`This Gist has more than ${LIMITS.files} supported profile files.`);
  const files: { name: string; text: string }[] = [];
  for (const item of result.files) {
    if (!item || typeof item !== "object") throw new Error("A Gist file response is invalid.");
    const file = item as { name?: unknown; content?: unknown; truncated?: unknown };
    if (typeof file.name !== "string" || !safeGistFilename(file.name))
      throw new Error("A Gist filename is not supported.");
    if (file.truncated === true)
      throw new Error(`${file.name} is too large for GitHub's Gist content response.`);
    if (typeof file.content !== "string") throw new Error(`${file.name} has no text content.`);
    files.push({ name: file.name, text: file.content });
  }
  validateGistFiles(files);
  return { files };
}
