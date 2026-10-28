import type { PluginRpcContract } from "@getpaseo/plugin";
import type {
  applyPreview,
  currentProfiles,
  historyList,
  importPreview,
  listLibrary,
  recoveryList,
} from "../shared/rpc";
import type { Profile } from "../shared/set";

type RpcResult<Contract extends PluginRpcContract> =
  Contract extends PluginRpcContract<infer _Input, infer Output>
    ? import("zod").output<Output>
    : never;

export type CurrentState = RpcResult<typeof currentProfiles>;
export type LibraryState = RpcResult<typeof listLibrary>;
export type ImportPreviewState = RpcResult<typeof importPreview>;
export type ApplyPreviewState = RpcResult<typeof applyPreview>;
export type RecoveryState = RpcResult<typeof recoveryList>;
export type HistoryState = RpcResult<typeof historyList>;

export type SelectionChoice = {
  action: "skip" | "keep-both" | "replace" | "add";
  targetId?: string;
};

export type ImportMode = "new" | "match" | "update";

export type ImportDraft = {
  root: string;
  preferenceRoot: string;
  hostId: string;
  files: { name: string; text: string }[];
  text: string;
  hostPath: string;
  gistUrl: string;
  mode: ImportMode;
  targetLocalId: string;
  targetFileIndex: number;
  previewSourceFileIndex: number;
  preview: ImportPreviewState | null;
  apply: ApplyPreviewState | null;
  replaceLocalChanges: boolean;
  busy: boolean;
  error: string | null;
  result: string | null;
};

export type ApplyDraft = {
  kind: "set" | "snapshot";
  root: string;
  preferenceRoot: string;
  hostId: string;
  localId?: string;
  snapshotId?: string;
  sourceName?: string;
  profiles?: Profile[];
  appendSystemPrompt?: string;
  applySystemPrompt?: boolean;
  mode: "use" | "add" | "restore";
  selected: string[];
  choices: Record<string, SelectionChoice>;
  preview: ApplyPreviewState | null;
  busy: boolean;
  error: string | null;
};

export type CaptureDraft =
  | { kind: "new" }
  | { kind: "update"; localId: string; name: string; revision: string; root: string };

export type ExportState = {
  files: { name: string; text: string }[];
  error: string | null;
  status: string | null;
  busy: boolean;
  busyAction?: "copy" | "write" | "gist" | "gist-url";
  gistUrl?: string | null;
  /** One-off portable-link exclusion for a full library-pack export. */
  gistLinkExport?: { libraryRoot: string; localId: string; excluded: boolean };
};
