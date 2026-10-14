import { Platform } from "react-native";
import { LIMITS } from "../shared/set";

export interface TransferFile {
  name: string;
  text: string;
}

interface BrowserFile {
  readonly name: string;
  readonly size: number;
  text(): Promise<string>;
}

interface BrowserFileInput {
  type: string;
  multiple: boolean;
  accept: string;
  value: string;
  files: ArrayLike<BrowserFile> | null;
  onchange: (() => void) | null;
  oncancel?: (() => void) | null;
  onerror: (() => void) | null;
  click(): void;
  remove(): void;
}

interface BrowserAnchor {
  href: string;
  download: string;
  click(): void;
  remove(): void;
}

interface BrowserDocument {
  createElement(tag: "input"): BrowserFileInput;
  createElement(tag: "a"): BrowserAnchor;
  body: { appendChild(node: BrowserFileInput | BrowserAnchor): void };
}

interface BrowserBlob {
  readonly __blob?: never;
}

interface BrowserGlobals {
  document?: BrowserDocument;
  Blob?: new (parts: string[], options: { type: string }) => BrowserBlob;
  URL?: {
    createObjectURL(blob: BrowserBlob): string;
    revokeObjectURL(url: string): void;
  };
}

function browserGlobals(): BrowserGlobals {
  return globalThis as unknown as BrowserGlobals;
}

/** Browser device-file selection; native clients should use host-file RPCs or paste text. */
export async function chooseBrowserFiles(): Promise<TransferFile[] | null> {
  if (Platform.OS !== "web") {
    throw new Error(
      "Device file selection is available in the web client only. Use a host file path or paste YAML on native clients.",
    );
  }
  const document = browserGlobals().document;
  if (!document) throw new Error("Device file selection is available in the web client only.");

  return new Promise<TransferFile[] | null>((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.accept = ".yaml,.yml,.json,application/yaml,application/json,text/yaml,text/plain";
    document.body.appendChild(input);

    let settled = false;
    const finish = (result: TransferFile[] | null, error?: unknown) => {
      if (settled) return;
      settled = true;
      input.onchange = null;
      input.oncancel = null;
      input.onerror = null;
      input.remove();
      if (error) reject(error);
      else resolve(result);
    };

    input.onchange = () => {
      const files = Array.from(input.files ?? []);
      if (files.length === 0) {
        finish(null);
        return;
      }
      if (files.length > LIMITS.files) {
        finish(null, new Error(`Choose no more than ${LIMITS.files} files at once.`));
        return;
      }
      const totalBytes = files.reduce((total, file) => total + file.size, 0);
      if (
        files.some(
          (file) => !Number.isFinite(file.size) || file.size < 0 || file.size > LIMITS.bytes,
        )
      ) {
        finish(
          null,
          new Error(
            `Each selected file must be ${LIMITS.bytes.toLocaleString()} bytes or smaller.`,
          ),
        );
        return;
      }
      if (!Number.isFinite(totalBytes) || totalBytes > LIMITS.bytes * LIMITS.files) {
        finish(
          null,
          new Error(`The selected files exceed the ${LIMITS.files}-file import size limit.`),
        );
        return;
      }
      void Promise.all(files.map(async (file) => ({ name: file.name, text: await file.text() })))
        .then((files) => finish(files))
        .catch((error: unknown) => finish(null, error));
    };
    input.oncancel = () => finish(null);
    input.onerror = () => finish(null, new Error("The selected files could not be read."));
    input.click();
  });
}

/** Starts one browser download per exported set. */
export function startBrowserDownloads(files: readonly TransferFile[]): number {
  if (Platform.OS !== "web") {
    throw new Error(
      "Browser downloads are available in the web client only. Use Copy YAML or Write to host path on native clients.",
    );
  }
  const { document, Blob, URL } = browserGlobals();
  if (!document || !Blob || !URL)
    throw new Error("Browser downloads are unavailable in this client.");

  let started = 0;
  for (const file of files) {
    const blob = new Blob([file.text], { type: "application/yaml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = file.name;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
    started += 1;
  }
  return started;
}
