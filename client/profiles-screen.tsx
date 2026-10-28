import { type PluginScreenProps, usePaseo, useRpc, useSettings } from "@getpaseo/plugin/client";
import {
  copyText,
  Modal,
  ScrollView,
  TextInput,
  useToast,
} from "@getpaseo/plugin/client/react-native";
import { SettingsAction, SettingsCard, SettingsSection } from "@getpaseo/plugin/client/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import { canonicalJson } from "../shared/canonical";
import type { GistStatus } from "../shared/gist";
import { preferences } from "../shared/preferences";
import {
  applyCommit,
  applyPreview,
  captureCurrent,
  createGist,
  currentProfiles,
  deleteSet,
  duplicateSet,
  exportProfiles,
  gistAvailability as gistAvailabilityContract,
  gistStatus as gistStatusContract,
  historyList,
  importCommit,
  importPreview,
  listLibrary,
  readGist,
  readHostFile,
  recoveryList,
  restoreHistory,
  saveSet,
  writeHostFile,
} from "../shared/rpc";
import type { LibraryEntry, Profile } from "../shared/set";
import { ActionRow } from "./action-row";
import { GistPublication } from "./gist-publication";
import type {
  ApplyDraft,
  CurrentState,
  ExportState,
  HistoryState,
  ImportDraft,
  LibraryState,
  RecoveryState,
  SelectionChoice,
} from "./models";
import { ProfileAppearance, ProfileAppearanceFields } from "./profile-appearance";
import { ApplyReview, ExportReview, ImportReview } from "./review-dialogs";
import { SelectAllAction } from "./select-all-action";
import { SharedPromptReview } from "./shared-prompt-review";
import { useWriteRpc } from "./use-write-rpc";
import { chooseBrowserFiles, startBrowserDownloads, type TransferFile } from "./web";

type CaptureDraft = { kind: "new" } | { kind: "update"; entry: LibraryEntry; root: string };

const styles = {
  root: { flex: 1, minHeight: 0 },
  content: {
    padding: 16,
    gap: 16,
    maxWidth: 720,
    width: "100%" as const,
    alignSelf: "center" as const,
  },
  header: { gap: 6 },
  sectionHeader: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 8 },
  row: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: 1,
  },
  rowText: { flex: 1, minWidth: 0, gap: 3 },
  buttonRow: { gap: 0 },
  input: { borderWidth: 1, borderRadius: 8, padding: 12, minHeight: 44 },
  multiline: { minHeight: 150, textAlignVertical: "top" as const },
  cardBody: { gap: 10, paddingVertical: 6 },
};

export function ProfileSetsScreen({ theme, host }: PluginScreenProps) {
  const settings = useSettings(preferences);
  const paseo = usePaseo();
  const toast = useToast();
  const queryClient = useQueryClient();
  const listLibraryRpc = useRpc(listLibrary);
  const currentProfilesRpc = useRpc(currentProfiles);
  const captureCurrentRpc = useWriteRpc(captureCurrent);
  const exportProfilesRpc = useRpc(exportProfiles);
  const gistAvailabilityRpc = useRpc(gistAvailabilityContract);
  const gistStatusRpc = useRpc(gistStatusContract);
  const createGistRpc = useWriteRpc(createGist);
  const readGistRpc = useRpc(readGist);
  const importPreviewRpc = useRpc(importPreview);
  const importCommitRpc = useWriteRpc(importCommit);
  const applyPreviewRpc = useRpc(applyPreview);
  const applyCommitRpc = useWriteRpc(applyCommit);
  const readHostFileRpc = useRpc(readHostFile);
  const writeHostFileRpc = useWriteRpc(writeHostFile);
  const duplicateSetRpc = useWriteRpc(duplicateSet);
  const deleteSetRpc = useWriteRpc(deleteSet);
  const saveSetRpc = useWriteRpc(saveSet);
  const historyListRpc = useRpc(historyList);
  const restoreHistoryRpc = useWriteRpc(restoreHistory);
  const recoveryListRpc = useRpc(recoveryList);

  const configuredRoot = settings.status === "ready" ? settings.values.libraryDirectory : "";
  const [library, setLibrary] = useState<{
    /** The exact root passed to the RPC (may be the host's resolved default path). */
    requestedRoot: string;
    /** The settings value that selected the requested root. */
    requestedPreferenceRoot: string;
    loadedForRoot: string;
    loadedForHost: string;
    resolvedRoot: string;
    entries: LibraryEntry[];
    errors: LibraryState["errors"];
    loading: boolean;
    error: string | null;
  }>({
    requestedRoot: "",
    requestedPreferenceRoot: "",
    loadedForRoot: "",
    loadedForHost: "",
    resolvedRoot: "",
    entries: [],
    errors: [],
    loading: true,
    error: null,
  });
  const [current, setCurrent] = useState<CurrentState | null>(null);
  const [currentLoading, setCurrentLoading] = useState(true);
  const [currentError, setCurrentError] = useState<string | null>(null);
  const [selectedProfiles, setSelectedProfiles] = useState<string[]>([]);
  const [selectedLibrary, setSelectedLibrary] = useState<string[]>([]);
  const [detail, setDetail] = useState<{ entry: LibraryEntry; root: string } | null>(null);
  const [detailName, setDetailName] = useState("");
  const [detailError, setDetailError] = useState<string | null>(null);
  const [gistStatuses, setGistStatuses] = useState<Record<string, GistStatus>>({});
  const [deleteArmed, setDeleteArmed] = useState(false);
  const [history, setHistory] = useState<{
    localId: string;
    root: string;
    value: HistoryState;
  } | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [capture, setCapture] = useState<CaptureDraft | null>(null);
  const [captureName, setCaptureName] = useState("");
  const [captureSelected, setCaptureSelected] = useState<string[]>([]);
  const [captureBusy, setCaptureBusy] = useState(false);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [importDraft, setImportDraft] = useState<ImportDraft | null>(null);
  const [applyDraft, setApplyDraft] = useState<ApplyDraft | null>(null);
  const [exportState, setExportState] = useState<ExportState | null>(null);
  const [exportPath, setExportPath] = useState("");
  const [exportSelectedName, setExportSelectedName] = useState("");
  const [recovery, setRecovery] = useState<RecoveryState | null>(null);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const [recoveryLoading, setRecoveryLoading] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [screenError, setScreenError] = useState<string | null>(null);
  const [gistStatus, setGistStatus] = useState<{
    hostId: string;
    checking: boolean;
    available: boolean;
    message: string | null;
  }>({ hostId: "", checking: false, available: false, message: null });
  const currentRequest = useRef(0);
  const libraryRequest = useRef(0);
  const gistStatusRequest = useRef(0);
  const currentLibraryContext = useRef({
    preferenceRoot: configuredRoot,
    hostId: host.id,
    resolvedRoot: "",
  });
  currentLibraryContext.current = {
    preferenceRoot: configuredRoot,
    hostId: host.id,
    resolvedRoot:
      library.loadedForRoot === configuredRoot && library.loadedForHost === host.id
        ? library.resolvedRoot
        : "",
  };
  const captureLock = useRef(false);
  const importCommitLock = useRef(false);
  const applyCommitLock = useRef(false);

  const gistAvailable =
    gistStatus.hostId === host.id && !gistStatus.checking && gistStatus.available;
  const gistAvailabilityMessage =
    gistStatus.hostId !== host.id || gistStatus.checking
      ? "Checking whether GitHub CLI is available on this Paseo host."
      : (gistStatus.message ?? "GitHub CLI (gh) is not available on this Paseo host.");

  const colors = theme.colors;
  const textStyle = useMemo(() => ({ color: colors.foreground }), [colors.foreground]);
  const mutedStyle = useMemo(() => ({ color: colors.foregroundMuted }), [colors.foregroundMuted]);
  const dangerStyle = useMemo(() => ({ color: colors.statusDanger }), [colors.statusDanger]);
  const warningStyle = useMemo(() => ({ color: colors.statusWarning }), [colors.statusWarning]);
  const borderStyle = useMemo(() => ({ borderColor: colors.border }), [colors.border]);
  const fieldStyle = useMemo(
    () => [styles.input, textStyle, borderStyle, { backgroundColor: colors.surface1 }],
    [borderStyle, colors.surface1, textStyle],
  );

  const refreshLibrary = useCallback(
    async (root: string): Promise<LibraryState | null> => {
      const preferenceRoot = configuredRoot;
      const targetHost = host.id;
      const context = currentLibraryContext.current;
      if (
        context.preferenceRoot !== preferenceRoot ||
        context.hostId !== targetHost ||
        (root !== preferenceRoot && root !== context.resolvedRoot)
      )
        return null;
      const request = ++libraryRequest.current;
      setLibrary((currentValue) => ({
        ...currentValue,
        requestedRoot: root,
        requestedPreferenceRoot: preferenceRoot,
        loading: true,
        error: null,
      }));
      try {
        const queryKey = ["profile-packs", "library", targetHost, root];
        await queryClient.cancelQueries({ queryKey, exact: true });
        const result = await queryClient.fetchQuery({
          queryKey,
          queryFn: () => listLibraryRpc({ libraryRoot: root }),
          staleTime: 0,
          retry: false,
        });
        if (
          request !== libraryRequest.current ||
          currentLibraryContext.current.preferenceRoot !== preferenceRoot ||
          currentLibraryContext.current.hostId !== targetHost
        )
          return null;
        setLibrary({
          requestedRoot: root,
          requestedPreferenceRoot: preferenceRoot,
          loadedForRoot: preferenceRoot,
          loadedForHost: targetHost,
          resolvedRoot: result.libraryRoot,
          entries: result.entries,
          errors: result.errors,
          loading: false,
          error: null,
        });
        try {
          const gistResult = await gistStatusRpc({ libraryRoot: result.libraryRoot, check: false });
          if (request === libraryRequest.current) {
            setGistStatuses(
              Object.fromEntries(gistResult.statuses.map((status) => [status.localId, status])),
            );
          }
        } catch {
          // Gist list subtitles are cached convenience data; library loading remains independent.
        }
        return result;
      } catch (error) {
        if (
          request !== libraryRequest.current ||
          currentLibraryContext.current.preferenceRoot !== preferenceRoot ||
          currentLibraryContext.current.hostId !== targetHost
        )
          return null;
        const message = errorMessage(error);
        setLibrary((currentValue) => ({
          ...currentValue,
          requestedRoot: root,
          requestedPreferenceRoot: preferenceRoot,
          loading: false,
          error: message,
        }));
        return null;
      }
    },
    [configuredRoot, gistStatusRpc, host.id, listLibraryRpc, queryClient],
  );

  const refreshCurrent = useCallback(async () => {
    const request = ++currentRequest.current;
    setCurrentLoading(true);
    try {
      const queryKey = ["profile-packs", "current", host.id];
      await queryClient.cancelQueries({ queryKey, exact: true });
      const result = await queryClient.fetchQuery({
        queryKey,
        queryFn: () => currentProfilesRpc({}),
        staleTime: 0,
        retry: false,
      });
      if (request !== currentRequest.current) return;
      setCurrent(result);
      setCurrentError(null);
      setSelectedProfiles((selected) =>
        selected.filter((id) => result.profiles.some((profile) => profile.id === id)),
      );
    } catch (error) {
      if (request === currentRequest.current) setCurrentError(errorMessage(error));
    } finally {
      if (request === currentRequest.current) setCurrentLoading(false);
    }
  }, [currentProfilesRpc, host.id, queryClient]);

  useEffect(() => {
    if (settings.status === "ready") void refreshLibrary(configuredRoot);
  }, [configuredRoot, refreshLibrary, settings.status]);

  useEffect(() => {
    void refreshCurrent();
    const observation = paseo.observeEvents(["status.daemon_config_changed"]);
    observation.subscribe({
      snapshot: () => {
        void refreshCurrent();
      },
      update: (message) => {
        if (message.type !== "status") return;
        const payload = message.payload as { status?: string };
        if (payload.status === "daemon_config_changed") void refreshCurrent();
      },
      error: (error) => setCurrentError(errorMessage(error)),
    });
    return () => {
      void observation.release();
    };
  }, [paseo, refreshCurrent]);

  const resolvedRoot = library.resolvedRoot;
  const libraryReady =
    !library.loading &&
    !library.error &&
    library.loadedForRoot === configuredRoot &&
    library.loadedForHost === host.id &&
    !!resolvedRoot;
  const currentProfilesValue = current?.profiles ?? [];
  const entries =
    library.loadedForRoot === configuredRoot && library.loadedForHost === host.id
      ? library.entries
      : [];
  const importTargetChanged =
    !!importDraft &&
    (importDraft.root !== resolvedRoot ||
      importDraft.preferenceRoot !== configuredRoot ||
      importDraft.hostId !== host.id);
  const applyTargetChanged =
    !!applyDraft &&
    (applyDraft.root !== resolvedRoot ||
      applyDraft.preferenceRoot !== configuredRoot ||
      applyDraft.hostId !== host.id);
  const matchingEntryIds = useMemo(
    () =>
      new Set(
        entries
          .filter(
            (entry) =>
              canonicalJson(entry.set.profiles) === canonicalJson(currentProfilesValue) &&
              (entry.set.appendSystemPrompt === undefined ||
                entry.set.appendSystemPrompt === current?.appendSystemPrompt),
          )
          .map((entry) => entry.localId),
      ),
    [currentProfilesValue, current?.appendSystemPrompt, entries],
  );

  const setImport = useCallback((update: Partial<ImportDraft>) => {
    setImportDraft((draft) => (draft ? { ...draft, ...update } : draft));
  }, []);

  const refreshGistAvailability = useCallback(async () => {
    const request = ++gistStatusRequest.current;
    const targetHostId = host.id;
    setGistStatus({ hostId: targetHostId, checking: true, available: false, message: null });
    try {
      const result = await gistAvailabilityRpc({});
      if (request !== gistStatusRequest.current) return;
      setGistStatus({
        hostId: targetHostId,
        checking: false,
        available: result.available,
        message: result.message ?? null,
      });
    } catch (error) {
      if (request !== gistStatusRequest.current) return;
      setGistStatus({
        hostId: targetHostId,
        checking: false,
        available: false,
        message: `Could not check GitHub CLI availability: ${errorMessage(error)}`,
      });
    }
  }, [gistAvailabilityRpc, host.id]);

  const openCapture = useCallback(
    (mode: CaptureDraft) => {
      setCapture(mode);
      setCaptureName(mode.kind === "update" ? mode.entry.set.name : "");
      setCaptureSelected(
        mode.kind === "update" ? currentProfilesValue.map(({ id }) => id) : selectedProfiles,
      );
      setCaptureError(null);
    },
    [currentProfilesValue, selectedProfiles],
  );

  const openImport = useCallback(() => {
    void refreshGistAvailability();
    setImportDraft({
      root: resolvedRoot,
      preferenceRoot: configuredRoot,
      hostId: host.id,
      files: [],
      text: "",
      hostPath: "",
      gistUrl: "",
      mode: "match",
      targetLocalId: "",
      targetFileIndex: -1,
      previewSourceFileIndex: -1,
      preview: null,
      apply: null,
      replaceLocalChanges: false,
      busy: false,
      error: null,
      result: null,
    });
  }, [configuredRoot, host.id, refreshGistAvailability, resolvedRoot]);

  const doCapture = useCallback(async () => {
    if (!capture || !current || captureSelected.length === 0 || captureBusy || captureLock.current)
      return;
    captureLock.current = true;
    setCaptureBusy(true);
    setCaptureError(null);
    try {
      const entry = await captureCurrentRpc({
        libraryRoot: capture.kind === "update" ? capture.root : resolvedRoot,
        name: capture.kind === "update" ? capture.entry.set.name : captureName.trim(),
        profileIds: captureSelected,
        expectedCurrentRevision: current.revision,
        ...(capture.kind === "update"
          ? { localId: capture.entry.localId, expectedRevision: capture.entry.revision }
          : {}),
      });
      const targetRoot = capture.kind === "update" ? capture.root : resolvedRoot;
      const result = await refreshLibrary(targetRoot);
      const updated = result?.entries.find(({ localId }) => localId === entry.localId) ?? entry;
      setDetail({ entry: updated, root: targetRoot });
      setDetailName(updated.set.name);
      setCapture(null);
      toast.show(
        capture.kind === "update"
          ? "Saved pack updated from current profiles"
          : "Current profiles saved as a pack",
        { variant: "success" },
      );
    } catch (error) {
      setCaptureError(errorMessage(error));
    } finally {
      captureLock.current = false;
      setCaptureBusy(false);
    }
  }, [
    capture,
    captureBusy,
    captureCurrentRpc,
    captureName,
    captureSelected,
    current,
    refreshLibrary,
    resolvedRoot,
    toast,
  ]);

  const openDetail = useCallback(
    (entry: LibraryEntry) => {
      setDetail({ entry, root: resolvedRoot });
      setDetailName(entry.set.name);
      setDetailError(null);
      setDeleteArmed(false);
      setHistory(null);
      setHistoryError(null);
    },
    [resolvedRoot],
  );

  const renameDetail = useCallback(async () => {
    if (!detail || busyAction) return;
    setBusyAction("rename");
    setDetailError(null);
    try {
      const updated = await saveSetRpc({
        libraryRoot: detail.root,
        localId: detail.entry.localId,
        expectedRevision: detail.entry.revision,
        set: { ...detail.entry.set, name: detailName.trim() },
      });
      setDetail({ entry: updated, root: detail.root });
      await refreshLibrary(detail.root);
      toast.show("Pack renamed", { variant: "success" });
    } catch (error) {
      setDetailError(errorMessage(error));
    } finally {
      setBusyAction(null);
    }
  }, [busyAction, detail, detailName, refreshLibrary, saveSetRpc, toast]);

  const duplicateDetail = useCallback(async () => {
    if (!detail || busyAction) return;
    const name = detailName.trim();
    if (!name || name === detail.entry.set.name) {
      setDetailError("Enter a different name for the duplicate.");
      return;
    }
    setBusyAction("duplicate");
    setDetailError(null);
    try {
      const created = await duplicateSetRpc({
        libraryRoot: detail.root,
        localId: detail.entry.localId,
        expectedRevision: detail.entry.revision,
        name,
      });
      await refreshLibrary(detail.root);
      setDetail({ entry: created, root: detail.root });
      setDetailName(created.set.name);
      toast.show("Pack duplicated with a new portable identity", { variant: "success" });
    } catch (error) {
      setDetailError(errorMessage(error));
    } finally {
      setBusyAction(null);
    }
  }, [busyAction, detail, detailName, duplicateSetRpc, refreshLibrary, toast]);

  const updateAppearance = useCallback(
    async (profileId: string, change: { icon?: string; color?: string }) => {
      if (!detail || busyAction) return;
      setBusyAction("appearance");
      setDetailError(null);
      try {
        const updated = await saveSetRpc({
          libraryRoot: detail.root,
          localId: detail.entry.localId,
          expectedRevision: detail.entry.revision,
          set: {
            ...detail.entry.set,
            profiles: detail.entry.set.profiles.map((profile) =>
              profile.id === profileId ? { ...profile, ...change } : profile,
            ),
          },
        });
        setDetail({ entry: updated, root: detail.root });
        setHistory(null);
        await refreshLibrary(detail.root);
        toast.show("Profile appearance saved in this pack", { variant: "success" });
      } catch (error) {
        setDetailError(errorMessage(error));
      } finally {
        setBusyAction(null);
      }
    },
    [busyAction, detail, refreshLibrary, saveSetRpc, toast],
  );

  const removeDetail = useCallback(async () => {
    if (!detail || busyAction) return;
    if (!deleteArmed) {
      setDeleteArmed(true);
      return;
    }
    setBusyAction("delete");
    setDetailError(null);
    try {
      await deleteSetRpc({
        libraryRoot: detail.root,
        localId: detail.entry.localId,
        expectedRevision: detail.entry.revision,
      });
      setDetail(null);
      setHistory(null);
      await refreshLibrary(detail.root);
      toast.show("Pack deleted from the library", { variant: "success" });
    } catch (error) {
      setDetailError(errorMessage(error));
    } finally {
      setBusyAction(null);
    }
  }, [busyAction, deleteArmed, deleteSetRpc, detail, refreshLibrary, toast]);

  const showHistory = useCallback(async () => {
    if (!detail) return;
    setHistoryError(null);
    try {
      const value = await historyListRpc({
        libraryRoot: detail.root,
        localId: detail.entry.localId,
      });
      setHistory({ localId: detail.entry.localId, root: detail.root, value });
    } catch (error) {
      setHistoryError(errorMessage(error));
    }
  }, [detail, historyListRpc]);

  const restoreSavedVersion = useCallback(
    async (revision: string) => {
      if (!detail || busyAction) return;
      setBusyAction("history-restore");
      setDetailError(null);
      try {
        const restored = await restoreHistoryRpc({
          libraryRoot: detail.root,
          localId: detail.entry.localId,
          revision,
          expectedRevision: detail.entry.revision,
        });
        setDetail({ entry: restored, root: detail.root });
        setDetailName(restored.set.name);
        setHistory(null);
        await refreshLibrary(detail.root);
        toast.show("Saved library version restored; the previous head is in history", {
          variant: "success",
        });
      } catch (error) {
        setDetailError(errorMessage(error));
      } finally {
        setBusyAction(null);
      }
    },
    [busyAction, detail, refreshLibrary, restoreHistoryRpc, toast],
  );

  const previewImport = useCallback(async () => {
    if (!importDraft || importDraft.busy) return;
    if (importTargetChanged) {
      setImport({
        error:
          "The selected host or library folder changed. Refresh this target before previewing or saving.",
      });
      return;
    }
    const availableFiles =
      importDraft.files.length > 0
        ? importDraft.files
        : importDraft.text.trim()
          ? [{ name: "pasted-profile-pack.yaml", text: importDraft.text }]
          : [];
    if (availableFiles.length === 0) {
      setImport({ error: "Choose files, read a host file, or paste YAML/JSON first." });
      return;
    }
    if (importDraft.mode === "update" && availableFiles.length !== 1) {
      setImport({
        error:
          "Updating a selected pack accepts one file at a time. Use Match source ID for a batch.",
      });
      return;
    }
    if (
      importDraft.mode === "match" &&
      importDraft.targetLocalId &&
      importDraft.targetFileIndex < 0
    ) {
      setImport({ error: "Choose one source file and destination, then preview again." });
      return;
    }
    if (importDraft.mode === "update" && !importDraft.targetLocalId) {
      setImport({ error: "Choose the profile pack that this file should update." });
      return;
    }
    const files =
      importDraft.targetFileIndex >= 0
        ? [availableFiles[importDraft.targetFileIndex]].filter(
            (file): file is (typeof availableFiles)[number] => !!file,
          )
        : availableFiles;
    if (files.length === 0) {
      setImport({ error: "The selected source file is no longer available. Choose files again." });
      return;
    }
    setImport({
      busy: true,
      error: null,
      preview: null,
      apply: null,
      previewSourceFileIndex: -1,
      replaceLocalChanges: false,
    });
    try {
      const preview = await importPreviewRpc({
        libraryRoot: importDraft.root,
        files,
        asCopy: importDraft.mode === "new",
        ...(importDraft.targetLocalId && importDraft.mode !== "new"
          ? { targetLocalId: importDraft.targetLocalId }
          : {}),
      });
      setImport({ preview, previewSourceFileIndex: importDraft.targetFileIndex, busy: false });
    } catch (error) {
      setImport({
        busy: false,
        preview: null,
        apply: null,
        previewSourceFileIndex: -1,
        error: errorMessage(error),
      });
    }
  }, [importDraft, importPreviewRpc, importTargetChanged, setImport]);

  const readImportHostFile = useCallback(async () => {
    if (!importDraft || importDraft.busy || !importDraft.hostPath.trim()) return;
    setImport({ busy: true, error: null });
    try {
      const file = await readHostFileRpc({ path: importDraft.hostPath.trim() });
      setImport({
        busy: false,
        files: [file],
        text: "",
        gistUrl: "",
        targetFileIndex: -1,
        targetLocalId: "",
        previewSourceFileIndex: -1,
        preview: null,
        apply: null,
        result: null,
      });
    } catch (error) {
      setImport({ busy: false, error: errorMessage(error) });
    }
  }, [importDraft, readHostFileRpc, setImport]);

  const readImportGist = useCallback(async () => {
    if (!importDraft || importDraft.busy || !importDraft.gistUrl.trim() || !gistAvailable) return;
    setImport({ busy: true, error: null, result: null, preview: null, apply: null });
    try {
      const { files } = await readGistRpc({ url: importDraft.gistUrl.trim() });
      setImport({
        busy: false,
        files,
        text: "",
        hostPath: "",
        mode: "match",
        targetLocalId: "",
        targetFileIndex: -1,
        previewSourceFileIndex: -1,
        preview: null,
        apply: null,
        replaceLocalChanges: false,
        error: null,
        result: `Loaded ${files.length} file${files.length === 1 ? "" : "s"} from the Gist. Review the preview before saving or applying.`,
      });
    } catch (error) {
      setImport({
        busy: false,
        error: errorMessage(error),
        preview: null,
        apply: null,
        result: null,
      });
    }
  }, [gistAvailable, importDraft, readGistRpc, setImport]);

  const selectBrowserFiles = useCallback(async () => {
    if (Platform.OS !== "web" || !importDraft || importDraft.busy) return;
    setImport({ busy: true, error: null });
    try {
      const files = await chooseBrowserFiles();
      if (files)
        setImport({
          files,
          text: "",
          gistUrl: "",
          busy: false,
          targetFileIndex: -1,
          targetLocalId: "",
          previewSourceFileIndex: -1,
          preview: null,
          apply: null,
          result: null,
        });
      else setImport({ busy: false });
    } catch (error) {
      setImport({ busy: false, error: errorMessage(error) });
    }
  }, [importDraft, setImport]);

  const refreshImportTarget = useCallback(async () => {
    if (!importDraft || importDraft.busy) return;
    setImport({ busy: true, error: null });
    const result = await refreshLibrary(configuredRoot);
    if (!result) {
      setImport({
        busy: false,
        error:
          "Could not refresh the selected host and library folder. The import source is retained.",
      });
      return;
    }
    setImport({
      root: result.libraryRoot,
      preferenceRoot: configuredRoot,
      hostId: host.id,
      targetLocalId: "",
      targetFileIndex: -1,
      previewSourceFileIndex: -1,
      preview: null,
      apply: null,
      replaceLocalChanges: false,
      busy: false,
      error: null,
      result: null,
    });
  }, [configuredRoot, host.id, importDraft, refreshLibrary, setImport]);

  const startUpdateAndUseReview = useCallback(async () => {
    if (
      !importDraft?.preview ||
      (importDraft.mode !== "update" && importDraft.mode !== "match") ||
      importDraft.busy ||
      !importDraft.preview.items[0]?.target
    )
      return;
    if (importTargetChanged) {
      setImport({
        error:
          "The selected host or library folder changed. Refresh this target and review the import again.",
      });
      return;
    }
    setImport({ busy: true, error: null });
    try {
      const apply = await applyPreviewRpc({
        libraryRoot: importDraft.root,
        importPreviewId: importDraft.preview.previewId,
        mode: "use",
      });
      setImport({ apply, busy: false });
    } catch (error) {
      setImport({ busy: false, error: errorMessage(error) });
    }
  }, [applyPreviewRpc, importDraft, importTargetChanged, setImport]);

  const commitImport = useCallback(
    async (withApply: boolean) => {
      if (!importDraft?.preview || importDraft.busy || importCommitLock.current) return;
      if (importTargetChanged) {
        setImport({
          error:
            "The selected host or library folder changed. Refresh this target and review the import again.",
        });
        return;
      }
      if (withApply && !importDraft.apply) return;
      importCommitLock.current = true;
      setImport({ busy: true, error: null, result: null });
      try {
        const result = await importCommitRpc({
          libraryRoot: importDraft.root,
          previewId: importDraft.preview.previewId,
          replaceLocalChanges: importDraft.replaceLocalChanges,
          ...(withApply && importDraft.apply
            ? { applyPreviewId: importDraft.apply.previewId }
            : {}),
        });
        const completed = result.entries.length;
        const summary = result.libraryError
          ? `${completed} profile pack${completed === 1 ? "" : "s"} saved before an error: ${result.libraryError}. Current profiles were not applied.`
          : result.applied
            ? `Library updated and ${result.entries.length ? "reviewed profiles applied" : "current profiles updated"}.`
            : `${completed} profile pack${completed === 1 ? "" : "s"} saved to the library.`;
        const remainingFiles =
          importDraft.targetFileIndex >= 0
            ? completed > 0
              ? importDraft.files.filter((_, index) => index !== importDraft.targetFileIndex)
              : importDraft.files
            : importDraft.files.slice(completed);
        const remainingText =
          importDraft.files.length === 0 && completed === 0 ? importDraft.text : "";
        setImport({
          busy: false,
          result: summary,
          error: result.libraryError ?? result.applyError ?? null,
          preview: null,
          previewSourceFileIndex: -1,
          apply: null,
          files: remainingFiles,
          text: remainingText,
          targetLocalId: completed > 0 ? "" : importDraft.targetLocalId,
          targetFileIndex: completed > 0 ? -1 : importDraft.targetFileIndex,
          replaceLocalChanges: false,
        });
        await refreshLibrary(importDraft.root);
        if (result.applied) await refreshCurrent();
        if (result.libraryError) {
          toast.show(`${completed} completed before the library error`, { variant: "warning" });
        } else if (result.applyError) {
          toast.error(`Library updated, but Paseo profiles were not applied: ${result.applyError}`);
        } else {
          toast.show(summary, { variant: "success" });
        }
      } catch (error) {
        setImport({
          busy: false,
          preview: null,
          apply: null,
          error: `The commit result could not be confirmed. Review the source again before retrying. ${errorMessage(error)}`,
        });
      } finally {
        importCommitLock.current = false;
      }
    },
    [
      importCommitRpc,
      importDraft,
      importTargetChanged,
      refreshCurrent,
      refreshLibrary,
      setImport,
      toast,
    ],
  );

  const openApply = useCallback(
    (
      input: Omit<
        ApplyDraft,
        "preview" | "busy" | "error" | "choices" | "hostId" | "preferenceRoot"
      > & { choices?: Record<string, SelectionChoice> },
    ) => {
      setApplyDraft({
        ...input,
        hostId: host.id,
        preferenceRoot: configuredRoot,
        choices: input.choices ?? {},
        preview: null,
        busy: false,
        error: null,
      });
    },
    [configuredRoot, host.id],
  );

  const applySourceProfiles = useCallback(
    (draft: ApplyDraft): Profile[] => {
      if (draft.profiles) return draft.profiles;
      if (draft.kind !== "set" || !draft.localId) return [];
      return detail?.entry.localId === draft.localId
        ? detail.entry.set.profiles
        : (entries.find(({ localId }) => localId === draft.localId)?.set.profiles ?? []);
    },
    [detail, entries],
  );

  const defaultApplyChoices = useCallback(
    (profiles: Profile[]) => {
      const next: Record<string, SelectionChoice> = {};
      for (const source of profiles) {
        const sameId = currentProfilesValue.find((profile) => profile.id === source.id);
        if (!sameId) next[source.id] = { action: "add" };
        else if (canonicalJson(sameId) === canonicalJson(source))
          next[source.id] = { action: "skip" };
        else next[source.id] = { action: "keep-both" };
      }
      return next;
    },
    [currentProfilesValue],
  );

  const refreshApplyTarget = useCallback(async () => {
    if (!applyDraft || applyDraft.busy) return;
    setApplyDraft((draft) => (draft ? { ...draft, busy: true, error: null } : draft));
    const libraryResult = await refreshLibrary(configuredRoot);
    if (!libraryResult || libraryResult.errors.length > 0) {
      setApplyDraft((draft) =>
        draft
          ? {
              ...draft,
              busy: false,
              error:
                "Could not verify the refreshed library. The apply review is retained and remains blocked.",
            }
          : draft,
      );
      return;
    }
    if (applyDraft.kind === "snapshot") {
      try {
        const savedRecovery = await recoveryListRpc({ libraryRoot: libraryResult.libraryRoot });
        if (!savedRecovery.snapshots.some(({ id }) => id === applyDraft.snapshotId)) {
          setApplyDraft((draft) =>
            draft
              ? {
                  ...draft,
                  busy: false,
                  error:
                    "This recovery snapshot is not present on the refreshed host. Open recovery on the current host and choose a snapshot again.",
                }
              : draft,
          );
          return;
        }
        setApplyDraft((draft) =>
          draft
            ? {
                ...draft,
                root: libraryResult.libraryRoot,
                preferenceRoot: configuredRoot,
                hostId: host.id,
                preview: null,
                busy: false,
                error: null,
              }
            : draft,
        );
      } catch (error) {
        setApplyDraft((draft) =>
          draft
            ? {
                ...draft,
                busy: false,
                error: `Recovery records could not be refreshed: ${errorMessage(error)}`,
              }
            : draft,
        );
      }
      return;
    }
    const entry = libraryResult.entries.find(({ localId }) => localId === applyDraft.localId);
    if (!entry) {
      setApplyDraft((draft) =>
        draft
          ? {
              ...draft,
              busy: false,
              error:
                "This pack is not present in the refreshed library. Open the current library and choose a pack again.",
            }
          : draft,
      );
      return;
    }
    setApplyDraft((draft) =>
      draft
        ? {
            ...draft,
            root: libraryResult.libraryRoot,
            preferenceRoot: configuredRoot,
            hostId: host.id,
            sourceName: entry.set.name,
            profiles: entry.set.profiles,
            appendSystemPrompt: entry.set.appendSystemPrompt,
            applySystemPrompt: draft.mode === "use",
            selected: [],
            choices: {},
            preview: null,
            busy: false,
            error: null,
          }
        : draft,
    );
    await refreshCurrent();
  }, [applyDraft, configuredRoot, host.id, recoveryListRpc, refreshCurrent, refreshLibrary]);

  const launchSetApply = useCallback(
    (entry: LibraryEntry, root: string, mode: "use" | "add") => {
      setDetail(null);
      openApply({
        kind: "set",
        localId: entry.localId,
        sourceName: entry.set.name,
        profiles: entry.set.profiles,
        appendSystemPrompt: entry.set.appendSystemPrompt,
        applySystemPrompt: mode === "use",
        root,
        mode,
        selected: [],
        choices: defaultApplyChoices(entry.set.profiles),
      });
    },
    [defaultApplyChoices, openApply],
  );

  const reviewApply = useCallback(async () => {
    if (!applyDraft || applyDraft.busy) return;
    if (applyTargetChanged) {
      setApplyDraft((draft) =>
        draft
          ? {
              ...draft,
              error:
                "The selected host or library folder changed. Refresh this target before reviewing or applying.",
            }
          : draft,
      );
      return;
    }
    if (applyDraft.mode === "add" && applyDraft.selected.length === 0) return;
    const profiles = applySourceProfiles(applyDraft);
    const defaults = defaultApplyChoices(profiles);
    const selections =
      applyDraft.mode === "add" && applyDraft.kind === "set"
        ? profiles.map(({ id }) => ({
            profileId: id,
            ...(applyDraft.selected.includes(id)
              ? (applyDraft.choices[id] ?? defaults[id])
              : { action: "skip" as const }),
          }))
        : undefined;
    setApplyDraft((draft) => (draft ? { ...draft, busy: true, error: null } : draft));
    try {
      const preview = await applyPreviewRpc({
        libraryRoot: applyDraft.root,
        ...(applyDraft.localId ? { localId: applyDraft.localId } : {}),
        ...(applyDraft.snapshotId ? { snapshotId: applyDraft.snapshotId } : {}),
        mode: applyDraft.mode,
        ...(applyDraft.applySystemPrompt !== undefined
          ? { applySystemPrompt: applyDraft.applySystemPrompt }
          : {}),
        ...(selections ? { selections } : {}),
      });
      setApplyDraft((draft) => (draft ? { ...draft, busy: false, preview } : draft));
    } catch (error) {
      setApplyDraft((draft) =>
        draft ? { ...draft, busy: false, error: errorMessage(error) } : draft,
      );
    }
  }, [applyDraft, applyPreviewRpc, applySourceProfiles, applyTargetChanged, defaultApplyChoices]);

  const confirmApply = useCallback(async () => {
    if (!applyDraft?.preview || applyDraft.busy || applyCommitLock.current) return;
    if (applyTargetChanged) {
      setApplyDraft((draft) =>
        draft
          ? {
              ...draft,
              error:
                "The selected host or library folder changed. Refresh this target and review again before applying.",
            }
          : draft,
      );
      return;
    }
    applyCommitLock.current = true;
    setApplyDraft((draft) => (draft ? { ...draft, busy: true, error: null } : draft));
    try {
      await applyCommitRpc({
        libraryRoot: applyDraft.root,
        previewId: applyDraft.preview.previewId,
      });
      setApplyDraft(null);
      await refreshCurrent();
      toast.show(
        applyDraft.mode === "add"
          ? "Selected profiles added to Paseo"
          : "Paseo agent profiles updated",
        { variant: "success" },
      );
    } catch (error) {
      await refreshCurrent();
      setApplyDraft((draft) =>
        draft
          ? {
              ...draft,
              busy: false,
              preview: null,
              error: `The apply result could not be confirmed. Review current profiles and prepare a new preview. ${errorMessage(error)}`,
            }
          : draft,
      );
    } finally {
      applyCommitLock.current = false;
    }
  }, [applyCommitRpc, applyDraft, applyTargetChanged, refreshCurrent, toast]);

  const exportSelection = useCallback(
    async (source: "current" | "library") => {
      if (busyAction) return;
      const profileIds = source === "current" ? selectedProfiles : undefined;
      const localIds = source === "library" ? selectedLibrary : undefined;
      if (
        (source === "current" && (!profileIds?.length || !current)) ||
        (source === "library" && !localIds?.length)
      )
        return;
      setBusyAction("export");
      setScreenError(null);
      try {
        const result = await exportProfilesRpc({
          libraryRoot: resolvedRoot,
          source,
          ...(profileIds ? { profileIds, expectedCurrentRevision: current?.revision } : {}),
          ...(localIds ? { localIds } : {}),
        });
        void refreshGistAvailability();
        const initialName = result.files[0]?.name ?? "";
        setExportSelectedName(initialName);
        setExportState({
          files: result.files,
          error: null,
          status: null,
          busy: false,
          gistUrl: null,
          ...(source === "library" &&
          localIds?.length === 1 &&
          entries.find(({ localId }) => localId === localIds[0])?.set.gist
            ? {
                gistLinkExport: {
                  libraryRoot: resolvedRoot,
                  localId: localIds[0],
                  excluded: false,
                },
              }
            : {}),
        });
        setExportPath("");
      } catch (error) {
        setScreenError(errorMessage(error));
        toast.error(`Export failed: ${errorMessage(error)}`);
      } finally {
        setBusyAction(null);
      }
    },
    [
      busyAction,
      current,
      exportProfilesRpc,
      entries,
      refreshGistAvailability,
      resolvedRoot,
      selectedLibrary,
      selectedProfiles,
      toast,
    ],
  );

  const exportOneSet = useCallback(
    async (entry: LibraryEntry, root: string) => {
      if (busyAction) return;
      setDetail(null);
      setBusyAction("export");
      setScreenError(null);
      try {
        const { files } = await exportProfilesRpc({
          libraryRoot: root,
          source: "library",
          localIds: [entry.localId],
        });
        void refreshGistAvailability();
        setExportSelectedName(files[0]?.name ?? "");
        setExportState({
          files,
          error: null,
          status: null,
          busy: false,
          gistUrl: null,
          ...(entry.set.gist
            ? {
                gistLinkExport: {
                  libraryRoot: root,
                  localId: entry.localId,
                  excluded: false,
                },
              }
            : {}),
        });
        setExportPath("");
      } catch (error) {
        setScreenError(errorMessage(error));
        toast.error(`Export failed: ${errorMessage(error)}`);
      } finally {
        setBusyAction(null);
      }
    },
    [busyAction, exportProfilesRpc, refreshGistAvailability, toast],
  );

  const setExportGistLinkExcluded = useCallback(
    async (excluded: boolean) => {
      const currentExport = exportState;
      const source = currentExport?.gistLinkExport;
      if (!currentExport || !source || currentExport.busy) return;
      setExportState({ ...currentExport, busy: true, error: null });
      try {
        const { files } = await exportProfilesRpc({
          libraryRoot: source.libraryRoot,
          source: "library",
          localIds: [source.localId],
          excludeGistLink: excluded,
        });
        setExportSelectedName(files[0]?.name ?? "");
        setExportState((state) =>
          state
            ? {
                ...state,
                files,
                busy: false,
                error: null,
                gistLinkExport: { ...source, excluded },
              }
            : state,
        );
      } catch (error) {
        setExportState((state) =>
          state ? { ...state, busy: false, error: errorMessage(error) } : state,
        );
      }
    },
    [exportProfilesRpc, exportState],
  );

  const copyExportFile = useCallback(
    async (file: TransferFile | undefined) => {
      if (!file || !exportState) return;
      setExportState({ ...exportState, busy: true, busyAction: "copy", error: null });
      try {
        await copyText(file.text);
        setExportState({
          ...exportState,
          busy: false,
          busyAction: undefined,
          status: `${file.name} copied to the clipboard.`,
          error: null,
        });
        toast.show("YAML copied", { variant: "success" });
      } catch (error) {
        setExportState({
          ...exportState,
          busy: false,
          busyAction: undefined,
          error: `Clipboard copy failed: ${errorMessage(error)}. Select the YAML below and use Copy.`,
          status: null,
        });
      }
    },
    [exportState, toast],
  );

  const downloadExportFiles = useCallback(() => {
    if (!exportState || exportState.busy) return;
    try {
      const count = startBrowserDownloads(exportState.files);
      setExportState({
        ...exportState,
        status: `${count} download${count === 1 ? "" : "s"} started.`,
        error: null,
      });
    } catch (error) {
      setExportState({ ...exportState, error: errorMessage(error), status: null });
    }
  }, [exportState]);

  const writeExportFiles = useCallback(async () => {
    if (!exportState || !exportPath.trim() || exportState.busy) return;
    const basePath = exportPath.trim().replace(/[\\/]+$/, "");
    const files = exportState.files;
    setExportState({
      ...exportState,
      busy: true,
      busyAction: "write",
      status: null,
      error: null,
    });
    let written = 0;
    try {
      for (const file of files) {
        const path = files.length === 1 ? basePath : `${basePath}/${file.name}`;
        await writeHostFileRpc({ path, text: file.text });
        written += 1;
      }
      setExportState({
        ...exportState,
        busy: false,
        busyAction: undefined,
        status: `${written} file${written === 1 ? "" : "s"} saved on the Paseo host.`,
        error: null,
      });
    } catch (error) {
      setExportState({
        ...exportState,
        busy: false,
        busyAction: undefined,
        status: written
          ? `${written} file${written === 1 ? "" : "s"} saved before the next write failed.`
          : null,
        error: errorMessage(error),
      });
    }
  }, [exportPath, exportState, writeHostFileRpc]);

  const createSecretGist = useCallback(async () => {
    if (!exportState || exportState.busy || !gistAvailable) return;
    const files = exportState.files;
    setExportState({
      ...exportState,
      busy: true,
      busyAction: "gist",
      status: null,
      error: null,
    });
    try {
      const { url } = await createGistRpc({ files });
      setExportState({
        ...exportState,
        busy: false,
        busyAction: undefined,
        status: "Secret Gist created. Anyone with its URL can view the contents.",
        error: null,
        gistUrl: url,
      });
      toast.show("Secret Gist created", { variant: "success" });
    } catch (error) {
      setExportState({
        ...exportState,
        busy: false,
        busyAction: undefined,
        status: null,
        error: `Gist creation failed: ${errorMessage(error)}`,
      });
    }
  }, [createGistRpc, exportState, gistAvailable, toast]);

  const copyGistUrl = useCallback(async () => {
    if (!exportState?.gistUrl || exportState.busy) return;
    setExportState({ ...exportState, busy: true, busyAction: "gist-url", error: null });
    try {
      await copyText(exportState.gistUrl);
      setExportState({
        ...exportState,
        busy: false,
        busyAction: undefined,
        status: "Gist URL copied to the clipboard.",
        error: null,
      });
      toast.show("Gist URL copied", { variant: "success" });
    } catch (error) {
      setExportState({
        ...exportState,
        busy: false,
        busyAction: undefined,
        status: null,
        error: `Could not copy the Gist URL: ${errorMessage(error)}`,
      });
    }
  }, [exportState, toast]);

  const openRecovery = useCallback(async () => {
    setRecoveryLoading(true);
    setRecoveryError(null);
    try {
      setRecovery(await recoveryListRpc({ libraryRoot: resolvedRoot }));
    } catch (error) {
      setRecoveryError(errorMessage(error));
    } finally {
      setRecoveryLoading(false);
    }
  }, [recoveryListRpc, resolvedRoot]);

  const startRecoveryApply = useCallback(
    (snapshotId: string) => {
      setRecovery(null);
      openApply({
        kind: "snapshot",
        snapshotId,
        root: resolvedRoot,
        sourceName: "Recovery snapshot",
        mode: "restore",
        selected: [],
      });
    },
    [openApply, resolvedRoot],
  );

  const onGistStatus = useCallback((status: GistStatus) => {
    setGistStatuses((currentValue) => ({ ...currentValue, [status.localId]: status }));
  }, []);

  const onGistEntry = useCallback(
    (entry: LibraryEntry) => {
      setDetail((currentValue) =>
        currentValue?.entry.localId === entry.localId ? { ...currentValue, entry } : currentValue,
      );
      void refreshLibrary(detail?.root ?? resolvedRoot);
    },
    [detail?.root, refreshLibrary, resolvedRoot],
  );

  const reviewGistUpdates = useCallback(
    (files: Array<{ name: string; text: string }>) => {
      if (!detail || files.length !== 1) return;
      setImportDraft({
        root: detail.root,
        preferenceRoot: configuredRoot,
        hostId: host.id,
        files,
        text: "",
        hostPath: "",
        gistUrl: "",
        mode: "update",
        targetLocalId: detail.entry.localId,
        targetFileIndex: 0,
        previewSourceFileIndex: -1,
        preview: null,
        apply: null,
        replaceLocalChanges: false,
        busy: false,
        error: null,
        result: null,
      });
      setDetail(null);
    },
    [configuredRoot, detail, host.id],
  );

  const mainBusy = busyAction !== null;
  const targetChanged = importTargetChanged;

  return (
    <View style={[styles.root, { backgroundColor: colors.surface0 }]}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.header}>
          <Text style={mutedStyle}>
            Save reusable profile packs in a host library. Using a pack changes Paseo’s current
            agent profiles only after review.
          </Text>
          <Text selectable style={mutedStyle}>
            Library folder:{" "}
            {library.resolvedRoot ||
              (settings.status === "ready" ? "Resolving host folder…" : "Settings unavailable")}
          </Text>
          <View style={styles.buttonRow}>
            <ActionRow
              label="Refresh profile packs"
              actionLabel="Refresh"
              disabled={library.loading || mainBusy}
              onPress={() => void refreshLibrary(configuredRoot)}
            />
            <ActionRow
              label="Import profile packs"
              actionLabel="Import"
              disabled={!libraryReady || mainBusy}
              onPress={openImport}
            />
            <ActionRow
              label="Review recovery"
              actionLabel="Review"
              disabled={mainBusy}
              onPress={() => void openRecovery()}
            />
          </View>
        </View>

        {library.error ? (
          <Text accessibilityRole="alert" style={dangerStyle}>
            Library could not be read: {library.error}
          </Text>
        ) : null}
        {library.requestedPreferenceRoot !== configuredRoot ? (
          <Text style={warningStyle}>
            Loading the library for the current folder preference. Existing drafts stay attached to
            their original host folder.
          </Text>
        ) : null}
        {screenError ? (
          <Text accessibilityRole="alert" style={dangerStyle}>
            {screenError}
          </Text>
        ) : null}

        <SettingsSection
          title="Library"
          info="Saved packs live separately from the active Paseo profile catalog."
        >
          <SettingsCard>
            <View style={styles.sectionHeader}>
              <Text style={mutedStyle}>
                {library.loading
                  ? "Loading packs…"
                  : `${entries.length} saved pack${entries.length === 1 ? "" : "s"}`}
              </Text>
            </View>
            <View style={styles.buttonRow}>
              <SelectAllAction
                ids={entries.map((entry) => entry.localId)}
                selected={selectedLibrary}
                disabled={!libraryReady || mainBusy}
                onChange={setSelectedLibrary}
              />
              <ActionRow
                label={`Export selected${selectedLibrary.length ? ` (${selectedLibrary.length})` : ""}`}
                actionLabel="Export"
                disabled={!selectedLibrary.length || !libraryReady || mainBusy}
                onPress={() => void exportSelection("library")}
              />
            </View>
            {library.errors.map(({ name, error }) => (
              <View key={`${name}:${error}`} style={{ paddingHorizontal: 16, paddingVertical: 8 }}>
                <Text accessibilityRole="alert" style={dangerStyle}>
                  {name}: {error}
                </Text>
              </View>
            ))}
            {!library.loading && entries.length === 0 ? (
              <View style={{ paddingHorizontal: 16, paddingVertical: 12 }}>
                <Text style={mutedStyle}>
                  No readable packs in this library yet. Import files or save current profiles.
                </Text>
              </View>
            ) : null}
            {entries.map((entry) => {
              const checked = selectedLibrary.includes(entry.localId);
              const matches = matchingEntryIds.has(entry.localId);
              return (
                <View key={entry.localId} style={[styles.row, borderStyle]}>
                  <CheckButton
                    checked={checked}
                    label={`Select ${entry.set.name} for export`}
                    theme={theme}
                    onPress={() =>
                      setSelectedLibrary((selected) =>
                        checked
                          ? selected.filter((id) => id !== entry.localId)
                          : [...selected, entry.localId],
                      )
                    }
                  />
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => openDetail(entry)}
                    style={styles.rowText}
                  >
                    <Text style={[textStyle, { fontWeight: "600" }]} numberOfLines={1}>
                      {entry.set.name}
                    </Text>
                    <Text style={mutedStyle}>
                      {entry.set.profiles.length} profile
                      {entry.set.profiles.length === 1 ? "" : "s"}
                      {matches ? " · Matches current" : ""}
                      {gistStatuses[entry.localId]?.pointer
                        ? ` · ${statusSubtitle(gistStatuses[entry.localId])}`
                        : ""}
                    </Text>
                  </Pressable>
                </View>
              );
            })}
          </SettingsCard>
        </SettingsSection>

        <SettingsSection
          title="Current agent profiles"
          info="The selected Paseo host supplies this ordered catalog. Changes are refreshed after daemon configuration events."
        >
          <SettingsCard>
            <View style={styles.sectionHeader}>
              <Text style={mutedStyle}>
                {currentLoading
                  ? "Reading current profiles…"
                  : `${currentProfilesValue.length} profile${currentProfilesValue.length === 1 ? "" : "s"}`}
              </Text>
            </View>
            <View style={styles.buttonRow}>
              <SelectAllAction
                ids={currentProfilesValue.map((profile) => profile.id)}
                selected={selectedProfiles}
                disabled={!current || currentLoading || mainBusy}
                onChange={setSelectedProfiles}
              />
              <ActionRow
                label="Save selected as pack"
                actionLabel="Save pack"
                disabled={!current || selectedProfiles.length === 0 || !libraryReady || mainBusy}
                onPress={() => openCapture({ kind: "new" })}
              />
              <ActionRow
                label="Refresh current profiles"
                actionLabel="Refresh"
                disabled={currentLoading}
                onPress={() => void refreshCurrent()}
              />
              <ActionRow
                label={`Export selected${selectedProfiles.length ? ` (${selectedProfiles.length})` : ""}`}
                actionLabel="Export"
                disabled={!selectedProfiles.length || !current || mainBusy}
                onPress={() => void exportSelection("current")}
              />
            </View>
            {currentError ? (
              <View style={{ paddingHorizontal: 16, paddingVertical: 8 }}>
                <Text accessibilityRole="alert" style={dangerStyle}>
                  Current profiles unavailable: {currentError}
                </Text>
              </View>
            ) : null}
            {current?.warnings.map((warning) => (
              <View key={warning} style={{ paddingHorizontal: 16, paddingVertical: 4 }}>
                <Text style={warningStyle}>{warning}</Text>
              </View>
            ))}
            {!currentLoading && !currentError && currentProfilesValue.length === 0 ? (
              <View style={{ paddingHorizontal: 16, paddingVertical: 12 }}>
                <Text style={mutedStyle}>This host has no agent profiles configured.</Text>
              </View>
            ) : null}
            {currentProfilesValue.map((profile) => {
              const checked = selectedProfiles.includes(profile.id);
              return (
                <View key={profile.id} style={[styles.row, borderStyle]}>
                  <CheckButton
                    checked={checked}
                    label={`Select ${profile.name || profile.id}`}
                    theme={theme}
                    onPress={() =>
                      setSelectedProfiles((selected) =>
                        checked
                          ? selected.filter((id) => id !== profile.id)
                          : [...selected, profile.id],
                      )
                    }
                  />
                  <View style={styles.rowText}>
                    <Text style={[textStyle, { fontWeight: "600" }]} numberOfLines={1}>
                      {profile.name || profile.id}
                    </Text>
                    <Text style={mutedStyle} numberOfLines={2}>
                      {profile.provider || "Automatic provider"}
                      {profile.model ? ` · ${profile.model}` : ""} · {profile.id}
                    </Text>
                    <ProfileAppearance profile={profile} theme={theme} />
                  </View>
                </View>
              );
            })}
          </SettingsCard>
        </SettingsSection>
        {current?.appendSystemPrompt ? (
          <SettingsSection
            title="Current shared system prompt"
            info="Included when saving or exporting current profiles."
          >
            <SettingsCard>
              <View style={{ padding: 16 }}>
                <Text selectable style={textStyle}>
                  {current.appendSystemPrompt}
                </Text>
              </View>
            </SettingsCard>
          </SettingsSection>
        ) : null}
      </ScrollView>

      <Modal
        title="Save current profiles as a pack"
        open={capture !== null}
        onOpenChange={(open) => {
          if (!open && !captureBusy) setCapture(null);
        }}
      >
        <Modal.Content>
          <View style={{ gap: 12 }}>
            <Text style={textStyle}>
              {capture?.kind === "update"
                ? "Replace this saved pack with the selected current profiles. Its previous version will remain in library history."
                : "Save the checked current profiles as one reusable pack."}
            </Text>
            {capture?.kind === "new" ? (
              <TextInput
                accessibilityLabel="Pack name"
                placeholder="Pack name"
                placeholderTextColor={colors.foregroundMuted}
                value={captureName}
                onChangeText={setCaptureName}
                style={fieldStyle}
              />
            ) : null}
            <Text style={mutedStyle}>Includes the host's shared system prompt.</Text>
            <SelectAllAction
              ids={currentProfilesValue.map((profile) => profile.id)}
              selected={captureSelected}
              disabled={captureBusy}
              onChange={setCaptureSelected}
            />
            <ScrollView style={{ maxHeight: 340 }} keyboardShouldPersistTaps="handled">
              {currentProfilesValue.map((profile) => (
                <SelectableProfile
                  key={profile.id}
                  profile={profile}
                  selected={captureSelected.includes(profile.id)}
                  disabled={captureBusy}
                  theme={theme}
                  onToggle={() =>
                    setCaptureSelected((ids) =>
                      ids.includes(profile.id)
                        ? ids.filter((id) => id !== profile.id)
                        : [...ids, profile.id],
                    )
                  }
                />
              ))}
            </ScrollView>
            {captureError ? (
              <Text accessibilityRole="alert" style={dangerStyle}>
                {captureError}
              </Text>
            ) : null}
            <View style={styles.buttonRow}>
              <ActionRow
                label={
                  captureBusy
                    ? "Saving…"
                    : capture?.kind === "update"
                      ? "Update saved pack"
                      : "Save current profiles"
                }
                actionLabel={
                  captureBusy ? "Saving…" : capture?.kind === "update" ? "Update" : "Save pack"
                }
                disabled={
                  captureBusy ||
                  captureSelected.length === 0 ||
                  (capture?.kind === "new" && !captureName.trim())
                }
                onPress={() => void doCapture()}
              />
              <ActionRow
                label="Cancel"
                actionLabel="Cancel"
                disabled={captureBusy}
                onPress={() => setCapture(null)}
              />
            </View>
          </View>
        </Modal.Content>
      </Modal>

      <Modal
        title="Import profile packs"
        open={importDraft !== null}
        onOpenChange={(open) => {
          if (!open && !importDraft?.busy) setImportDraft(null);
        }}
      >
        <Modal.Content scrollable={false} contentContainerStyle={{ padding: 16, gap: 14 }}>
          {importDraft ? (
            <ImportReview
              draft={importDraft}
              entries={entries}
              targetChanged={targetChanged}
              theme={theme}
              onPatch={setImport}
              onRefreshTarget={() => void refreshImportTarget()}
              onChooseFiles={() => void selectBrowserFiles()}
              onReadHostFile={() => void readImportHostFile()}
              gistAvailable={gistAvailable}
              gistAvailabilityMessage={gistAvailabilityMessage}
              onReadGist={() => void readImportGist()}
              onPreview={() => void previewImport()}
              onUpdateAndUse={() => void startUpdateAndUseReview()}
              onCommit={(withApply) => void commitImport(withApply)}
            />
          ) : null}
        </Modal.Content>
      </Modal>

      <Modal
        title={detail?.entry.set.name ?? "Pack details"}
        open={detail !== null}
        onOpenChange={(open) => {
          if (!open && !busyAction) {
            setDetail(null);
            setHistory(null);
          }
        }}
      >
        <Modal.Content scrollable={false} contentContainerStyle={{ padding: 16 }}>
          {detail ? (
            <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 12 }}>
              <Text style={mutedStyle}>Library folder: {detail.root}</Text>
              {matchingEntryIds.has(detail.entry.localId) ? (
                <Text style={{ color: colors.statusSuccess }}>Matches current</Text>
              ) : null}
              <SettingsSection
                title="Profiles in this pack"
                info="Appearance edits are saved in this pack. Apply the pack to update Paseo."
              >
                <SettingsCard>
                  {detail.entry.set.profiles.map((profile) => (
                    <ProfileSummary
                      key={profile.id}
                      profile={profile}
                      theme={theme}
                      disabled={busyAction !== null}
                      onChangeAppearance={(change) => void updateAppearance(profile.id, change)}
                    />
                  ))}
                </SettingsCard>
              </SettingsSection>
              <SharedPromptReview after={detail.entry.set.appendSystemPrompt} theme={theme} />
              <GistPublication
                entry={detail.entry}
                libraryRoot={detail.root}
                hostName={host.label}
                theme={theme}
                disabled={busyAction !== null}
                initialStatus={gistStatuses[detail.entry.localId]}
                onEntry={onGistEntry}
                onStatus={onGistStatus}
                onReviewUpdates={reviewGistUpdates}
              />
              <SettingsSection
                title="Library actions"
                info="These actions change the saved pack. Use pack and Add selected change the live host catalog after review."
              >
                <SettingsCard>
                  <View style={{ padding: 16 }}>
                    <TextInput
                      accessibilityLabel="Pack name"
                      placeholder="Pack name"
                      placeholderTextColor={colors.foregroundMuted}
                      value={detailName}
                      onChangeText={(name) => {
                        setDetailName(name);
                        setDetailError(null);
                      }}
                      style={fieldStyle}
                    />
                  </View>
                  <View style={styles.buttonRow}>
                    <ActionRow
                      label="Rename pack"
                      actionLabel="Rename"
                      disabled={
                        busyAction !== null ||
                        !detailName.trim() ||
                        detailName.trim() === detail.entry.set.name
                      }
                      onPress={() => void renameDetail()}
                    />
                    <ActionRow
                      label="Duplicate pack"
                      actionLabel="Duplicate"
                      disabled={
                        busyAction !== null ||
                        !detailName.trim() ||
                        detailName.trim() === detail.entry.set.name
                      }
                      onPress={() => void duplicateDetail()}
                    />
                  </View>
                  <View style={styles.buttonRow}>
                    <ActionRow
                      label="Update from current profiles"
                      actionLabel="Update"
                      disabled={!current || !libraryReady || busyAction !== null}
                      onPress={() => {
                        setDetail(null);
                        openCapture({ kind: "update", entry: detail.entry, root: detail.root });
                      }}
                    />
                    <ActionRow
                      label="Review history"
                      actionLabel="History"
                      disabled={busyAction !== null}
                      onPress={() => void showHistory()}
                    />
                  </View>
                  <View style={styles.buttonRow}>
                    {deleteArmed ? (
                      <>
                        <View style={{ padding: 16 }}>
                          <Text style={warningStyle}>
                            Delete {detail.entry.set.name} from this library? This does not change
                            current Paseo profiles.
                          </Text>
                        </View>
                        <ActionRow
                          label="Confirm delete pack"
                          actionLabel="Delete"
                          disabled={busyAction !== null}
                          onPress={() => void removeDetail()}
                        />
                        <ActionRow
                          label="Cancel delete"
                          actionLabel="Cancel"
                          disabled={busyAction !== null}
                          onPress={() => setDeleteArmed(false)}
                        />
                      </>
                    ) : (
                      <ActionRow
                        label="Delete pack from library"
                        actionLabel="Delete"
                        disabled={busyAction !== null}
                        onPress={() => void removeDetail()}
                      />
                    )}
                  </View>
                </SettingsCard>
              </SettingsSection>
              <SettingsSection title="Paseo actions">
                <SettingsCard>
                  <View style={styles.buttonRow}>
                    <ActionRow
                      label="Use pack"
                      actionLabel="Use"
                      disabled={busyAction !== null}
                      onPress={() => launchSetApply(detail.entry, detail.root, "use")}
                    />
                    <ActionRow
                      label="Add selected profiles to Paseo"
                      actionLabel="Add selected"
                      disabled={busyAction !== null}
                      onPress={() => launchSetApply(detail.entry, detail.root, "add")}
                    />
                    <ActionRow
                      label="Export this pack"
                      actionLabel="Export"
                      disabled={busyAction !== null}
                      onPress={() => void exportOneSet(detail.entry, detail.root)}
                    />
                  </View>
                </SettingsCard>
              </SettingsSection>
              {detailError ? (
                <Text accessibilityRole="alert" style={dangerStyle}>
                  {detailError}
                </Text>
              ) : null}
              {historyError ? (
                <Text accessibilityRole="alert" style={dangerStyle}>
                  {historyError}
                </Text>
              ) : null}
              {history ? (
                <SettingsSection title="Saved versions">
                  <SettingsCard>
                    {history.value.versions.length === 0 ? (
                      <View style={{ padding: 16, gap: 8 }}>
                        <Text style={mutedStyle}>No earlier versions are available.</Text>
                      </View>
                    ) : null}
                    {history.value.versions.map((version) => (
                      <SettingsAction
                        key={version.revision}
                        label={version.name}
                        hint={version.createdAt}
                        actionLabel="Restore"
                        disabled={busyAction !== null}
                        onPress={() => void restoreSavedVersion(version.revision)}
                      />
                    ))}
                  </SettingsCard>
                </SettingsSection>
              ) : null}
            </ScrollView>
          ) : null}
        </Modal.Content>
      </Modal>

      <Modal
        title={
          applyDraft?.mode === "add"
            ? "Add profiles to Paseo"
            : applyDraft?.mode === "restore"
              ? "Restore previous profiles"
              : "Use profile pack"
        }
        open={applyDraft !== null}
        onOpenChange={(open) => {
          if (!open && !applyDraft?.busy) setApplyDraft(null);
        }}
      >
        <Modal.Content scrollable={false} contentContainerStyle={{ padding: 16 }}>
          {applyDraft ? (
            <ApplyReview
              draft={applyDraft}
              profiles={applySourceProfiles(applyDraft)}
              currentProfiles={currentProfilesValue}
              sourceLabel={
                applyDraft.sourceName ??
                (applyDraft.kind === "snapshot"
                  ? "Recovery snapshot"
                  : (entries.find(({ localId }) => localId === applyDraft.localId)?.set.name ??
                    "saved pack"))
              }
              theme={theme}
              defaultChoices={defaultApplyChoices}
              targetChanged={applyTargetChanged}
              onPatch={(update) =>
                setApplyDraft((draft) =>
                  draft
                    ? {
                        ...draft,
                        ...update,
                        preview:
                          update.selected ||
                          update.choices ||
                          update.applySystemPrompt !== undefined
                            ? null
                            : draft.preview,
                      }
                    : draft,
                )
              }
              onRefreshTarget={() => void refreshApplyTarget()}
              onReview={() => void reviewApply()}
              onConfirm={() => void confirmApply()}
            />
          ) : null}
        </Modal.Content>
      </Modal>

      <Modal
        title="Profile pack export"
        open={exportState !== null}
        onOpenChange={(open) => {
          if (!open && !exportState?.busy) setExportState(null);
        }}
      >
        <Modal.Content scrollable={false} contentContainerStyle={{ padding: 16 }}>
          {exportState ? (
            <ExportReview
              value={exportState}
              path={exportPath}
              selectedName={exportSelectedName}
              theme={theme}
              onPathChange={setExportPath}
              onSelectName={setExportSelectedName}
              onDownload={downloadExportFiles}
              onCopy={(file) => void copyExportFile(file)}
              onWrite={() => void writeExportFiles()}
              gistAvailable={gistAvailable}
              gistAvailabilityMessage={gistAvailabilityMessage}
              onCreateGist={() => void createSecretGist()}
              onCopyGistUrl={() => void copyGistUrl()}
              onGistLinkExportChange={(excluded) => void setExportGistLinkExcluded(excluded)}
            />
          ) : null}
        </Modal.Content>
      </Modal>

      <Modal
        title="Profile recovery"
        open={recovery !== null || recoveryLoading || recoveryError !== null}
        onOpenChange={(open) => {
          if (!open) {
            setRecovery(null);
            setRecoveryError(null);
          }
        }}
      >
        <Modal.Content scrollable={false} contentContainerStyle={{ padding: 16 }}>
          <ScrollView contentContainerStyle={{ gap: 12 }}>
            {recoveryLoading ? <Text style={mutedStyle}>Loading recovery records…</Text> : null}
            {recoveryError ? (
              <Text accessibilityRole="alert" style={dangerStyle}>
                {recoveryError}
              </Text>
            ) : null}
            {recovery ? (
              <>
                <SettingsSection title="Previous current-profile snapshots">
                  <SettingsCard>
                    {recovery.snapshots.length === 0 ? (
                      <View style={{ padding: 16 }}>
                        <Text style={mutedStyle}>No recovery snapshots are available.</Text>
                      </View>
                    ) : null}
                    {recovery.snapshots.map((snapshot) => (
                      <SettingsAction
                        key={snapshot.id}
                        label={`${snapshot.profileCount} profiles`}
                        hint={snapshot.createdAt}
                        actionLabel="Review"
                        onPress={() => startRecoveryApply(snapshot.id)}
                      />
                    ))}
                  </SettingsCard>
                </SettingsSection>
                <SettingsSection title="Recent apply operations">
                  <SettingsCard>
                    {recovery.operations.length === 0 ? (
                      <View style={{ padding: 16 }}>
                        <Text style={mutedStyle}>No apply operations have been recorded.</Text>
                      </View>
                    ) : null}
                    {recovery.operations.map((operation) => (
                      <View key={operation.id} style={[styles.row, borderStyle]}>
                        <View style={styles.rowText}>
                          <Text style={textStyle}>
                            {operation.sourceName} · {operation.status}
                          </Text>
                          <Text style={mutedStyle}>{operation.createdAt}</Text>
                          {operation.error ? (
                            <Text accessibilityRole="alert" style={dangerStyle}>
                              {operation.error}
                            </Text>
                          ) : null}
                        </View>
                      </View>
                    ))}
                  </SettingsCard>
                </SettingsSection>
              </>
            ) : null}
          </ScrollView>
        </Modal.Content>
      </Modal>
    </View>
  );
}

function ProfileSummary({
  profile,
  theme,
  disabled,
  onChangeAppearance,
}: {
  profile: Profile;
  theme: PluginScreenProps["theme"];
  disabled: boolean;
  onChangeAppearance(change: { icon?: string; color?: string }): void;
}) {
  const [editingAppearance, setEditingAppearance] = useState(false);
  return (
    <View
      style={{ paddingVertical: 8, borderBottomWidth: 1, borderColor: theme.colors.border, gap: 2 }}
    >
      <View style={{ paddingHorizontal: 16, gap: 2 }}>
        <Text style={{ color: theme.colors.foreground, fontWeight: "600" }}>
          {profile.name || profile.id}
        </Text>
        <Text style={{ color: theme.colors.foregroundMuted }}>
          {profile.provider || "Automatic provider"}
          {profile.model ? ` · ${profile.model}` : ""} · {profile.id}
        </Text>
        <ProfileAppearance profile={profile} theme={theme} />
        {profile.notes ? (
          <Text style={{ color: theme.colors.foregroundMuted }}>{profile.notes}</Text>
        ) : null}
      </View>
      <ActionRow
        label="Profile appearance"
        actionLabel={editingAppearance ? "Done" : "Edit"}
        disabled={disabled}
        onPress={() => setEditingAppearance((value) => !value)}
      />
      {editingAppearance ? (
        <ProfileAppearanceFields
          profile={profile}
          disabled={disabled}
          onChange={onChangeAppearance}
        />
      ) : null}
    </View>
  );
}

function SelectableProfile({
  profile,
  selected,
  disabled,
  theme,
  onToggle,
}: {
  profile: Profile;
  selected: boolean;
  disabled: boolean;
  theme: PluginScreenProps["theme"];
  onToggle(): void;
}) {
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked: selected, disabled }}
      disabled={disabled}
      onPress={onToggle}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        paddingVertical: 10,
        borderBottomWidth: 1,
        borderColor: theme.colors.border,
      }}
    >
      <Text style={{ color: theme.colors.foreground }}>{selected ? "☑" : "☐"}</Text>
      <View style={{ flex: 1 }}>
        <Text style={{ color: theme.colors.foreground }}>{profile.name || profile.id}</Text>
        <Text style={{ color: theme.colors.foregroundMuted }}>
          {profile.provider || "Automatic provider"} · {profile.id}
        </Text>
        <ProfileAppearance profile={profile} theme={theme} />
      </View>
    </Pressable>
  );
}

function CheckButton({
  checked,
  label,
  theme,
  onPress,
}: {
  checked: boolean;
  label: string;
  theme: PluginScreenProps["theme"];
  onPress(): void;
}) {
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityLabel={label}
      accessibilityState={{ checked }}
      onPress={onPress}
      style={{ minWidth: 36, minHeight: 44, alignItems: "center", justifyContent: "center" }}
    >
      <Text style={{ color: theme.colors.accent, fontSize: 18 }}>{checked ? "☑" : "☐"}</Text>
    </Pressable>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function statusSubtitle(status: GistStatus): string {
  switch (status.state) {
    case "link-conflict":
      return "Gist link conflict";
    case "needs-confirmation":
      return "Confirm Gist link";
    case "unresolved-operation":
      return "Publish needs checking";
    case "pending-first-publish":
      return "Pending first publish";
    case "unpublished-changes":
      return "Unpublished changes";
    case "remote-changed":
      return "Gist changed";
    case "both-changed":
      return "Both changed";
    case "link-change":
      return "Link change to publish";
    case "baseline-refresh":
      return "GitHub matches · mark as published";
    case "up-to-date":
      return "Up to date";
    case "check-github-account":
      return "Check GitHub account";
    case "check-failed":
      return "GitHub status unverified";
    case "blocked":
      return "Gist needs review";
    case "unlinked":
      return "";
  }
}
