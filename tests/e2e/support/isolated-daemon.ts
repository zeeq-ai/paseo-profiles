import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";

const PLUGIN_ID = "paseo-profiles";
const PROJECT_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const EXPECTED_CLI_VERSION = process.env.PASEO_PROFILES_CLI_VERSION ?? "0.11.2";

interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function command(
  executable: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; detached?: boolean },
) {
  return spawn(executable, args, {
    cwd: options.cwd,
    env: options.env,
    detached: options.detached,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function runCommand(
  executable: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<CommandResult> {
  const child = command(executable, args, { cwd, env });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout = `${stdout}${chunk.toString("utf8")}`.slice(-32_000);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString("utf8")}`.slice(-32_000);
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (exitCode) => resolve(exitCode));
  });
  return { code, stdout, stderr };
}

async function assertCliVersion(executable: string, cwd: string, env: NodeJS.ProcessEnv) {
  const result = await runCommand(executable, ["--version"], cwd, env);
  if (result.code !== 0 || result.stdout.trim() !== EXPECTED_CLI_VERSION) {
    throw new Error(
      `Expected Paseo CLI ${EXPECTED_CLI_VERSION}; got exit ${result.code}, stdout ${JSON.stringify(result.stdout)}, stderr ${JSON.stringify(result.stderr)}`,
    );
  }
}

function isolatedEnvironment(home: string, ghConfigDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PASEO_HOME: home, GH_CONFIG_DIR: ghConfigDir };
  // A test must never reach a developer's GitHub account, even if a fake `gh` is missing.
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  delete env.GH_ENTERPRISE_TOKEN;
  delete env.GITHUB_ENTERPRISE_TOKEN;
  delete env.GH_HOST;
  // Do not let a developer's endpoint, credentials, or local daemon override this fixture.
  delete env.PASEO_HOST;
  delete env.PASEO_PASSWORD;
  delete env.PASEO_LOCAL_CREDENTIAL;
  delete env.PASEO_PORT;
  return env;
}

async function allocatePort(excludedPorts: number[]): Promise<number> {
  const { createServer } = await import("node:net");
  while (true) {
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Could not allocate daemon port");
    const port = address.port;
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    if (!excludedPorts.includes(port)) return port;
  }
}

async function waitForDaemon(child: ChildProcess, baseUrl: string): Promise<void> {
  const deadline = Date.now() + 45_000;
  let lastError = "No response yet";
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `Daemon exited early (code ${String(child.exitCode)}, signal ${String(child.signalCode)})`,
      );
    }
    try {
      const response = await fetch(`${baseUrl}/api/status`, { signal: AbortSignal.timeout(1_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const status = (await response.json()) as { status?: string };
      if (status.status === "server_info") return;
      lastError = `Unexpected health response: ${JSON.stringify(status)}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${baseUrl}/api/status: ${lastError}`);
}

async function stopProcessTree(child: ChildProcess): Promise<void> {
  if (!child.pid) return;
  if (process.platform === "win32") {
    const result = await runCommand(
      "taskkill",
      ["/pid", String(child.pid), "/T", "/F"],
      process.cwd(),
      process.env,
    );
    if (result.code !== 0 && child.exitCode === null && child.signalCode === null)
      child.kill("SIGTERM");
  } else {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  }
  await Promise.race([
    child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve()
      : new Promise<void>((resolve) => child.once("exit", () => resolve())),
    delay(5_000),
  ]);
  if (process.platform === "win32") {
    await runCommand(
      "taskkill",
      ["/pid", String(child.pid), "/T", "/F"],
      process.cwd(),
      process.env,
    );
  } else {
    try {
      // Kill the process group even when the CLI parent has already exited.
      process.kill(-child.pid, "SIGKILL");
    } catch {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  }
}

export interface IsolatedDaemon {
  readonly home: string;
  readonly port: number;
  readonly baseUrl: string;
  readonly webUiEnabled: boolean;
  readonly client: DaemonClient;
  close(): Promise<void>;
}

export interface IsolatedDaemonOptions {
  /** Extra environment for the daemon and plugin install, e.g. a PATH with a fake `gh` first. */
  env?: NodeJS.ProcessEnv;
}

export async function startIsolatedDaemon(
  options: IsolatedDaemonOptions = {},
): Promise<IsolatedDaemon> {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-profiles-e2e-"));
  const home = path.join(root, ".paseo");
  const executable = process.env.PASEO_CLI_BIN ?? "paseo";
  const baseEnvironment = {
    ...isolatedEnvironment(home, path.join(root, "gh-config")),
    ...options.env,
  };
  const excludedPorts = [6767, 6768, Number(process.env.E2E_DAEMON_PORT ?? 0)];
  let daemonProcess: ChildProcess | undefined;
  let client: DaemonClient | undefined;

  try {
    await assertCliVersion(executable, PROJECT_ROOT, baseEnvironment);
    await mkdir(home, { recursive: true, mode: 0o700 });
    await writeFile(
      path.join(home, "config.json"),
      `${JSON.stringify({ version: 1, pluginsEnabled: true }, null, 2)}\n`,
      { flag: "wx", mode: 0o600 },
    );
    const port = await allocatePort(excludedPorts);
    const baseUrl = `http://127.0.0.1:${port}`;
    const webUiDirectory = process.env.PASEO_PROFILES_WEB_UI_DIST_DIR;
    const env: NodeJS.ProcessEnv = {
      ...baseEnvironment,
      PASEO_LISTEN: `127.0.0.1:${port}`,
      PASEO_RELAY_ENABLED: "false",
      PASEO_WEB_UI_ENABLED: webUiDirectory ? "true" : "false",
    };
    if (webUiDirectory) env.PASEO_WEB_UI_DIST_DIR = webUiDirectory;

    daemonProcess = command(executable, ["daemon", "run", "--home", home], {
      cwd: PROJECT_ROOT,
      env,
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let stderr = "";
    daemonProcess.stdout?.on("data", (chunk: Buffer) => {
      stdout = `${stdout}${chunk.toString("utf8")}`.slice(-32_000);
    });
    daemonProcess.stderr?.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-32_000);
    });

    try {
      await waitForDaemon(daemonProcess, baseUrl);
      const installed = await runCommand(
        executable,
        ["plugin", "install", PROJECT_ROOT, "--home", home, "--json"],
        PROJECT_ROOT,
        env,
      );
      if (installed.code !== 0) {
        throw new Error(
          `Plugin install failed (${installed.code}): ${installed.stderr || installed.stdout}`,
        );
      }
      client = new DaemonClient({
        url: `ws://127.0.0.1:${port}/ws`,
        clientId: `paseo-profiles-e2e-${randomUUID()}`,
        clientType: "cli",
        appVersion: EXPECTED_CLI_VERSION,
        connectTimeoutMs: 10_000,
        reconnect: { enabled: false },
      });
      await client.connect();
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\n${stdout}\n${stderr}`,
      );
    }

    return {
      home,
      port,
      baseUrl,
      webUiEnabled: Boolean(webUiDirectory),
      client,
      async close() {
        await client?.close().catch(() => undefined);
        if (daemonProcess) await stopProcessTree(daemonProcess);
        await rm(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await client?.close().catch(() => undefined);
    if (daemonProcess) await stopProcessTree(daemonProcess);
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

export function pluginId(): string {
  return PLUGIN_ID;
}
