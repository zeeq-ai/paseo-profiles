import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { openExternalUrl, useRpc } from "@getpaseo/plugin/client";
import {
  copyText,
  Modal,
  ScrollView,
  TextInput,
  useToast,
} from "@getpaseo/plugin/client/react-native";
import {
  SettingsCard,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import {
  type GistComparison,
  type GistOperation,
  type GistStatus,
  PORTABLE_LINK_MIN_PLUGIN_VERSION,
} from "../shared/gist";
import {
  gistLinkCommit,
  gistLinkPreview,
  gistPublishCommit,
  gistPublishOperation,
  gistPublishPreview,
  gistStatus,
  gistUnlink,
  inspectGist,
  readGist,
} from "../shared/rpc";
import type { LibraryEntry, ProfileSet } from "../shared/set";
import { ActionRow } from "./action-row";
import {
  GistAccountSummary,
  type GistLinkStorage,
  GistLinkStorageSelector,
  GistNamedChanges,
} from "./gist-review-parts";
import { useWriteRpc } from "./use-write-rpc";

type ScreenTheme = PluginScreenProps["theme"];

export function GistPublication({
  entry,
  libraryRoot,
  hostName,
  theme,
  initialStatus,
  disabled = false,
  onEntry,
  onStatus,
  onReviewUpdates,
}: {
  entry: LibraryEntry;
  libraryRoot: string;
  hostName: string;
  theme: ScreenTheme;
  initialStatus?: GistStatus;
  disabled?: boolean;
  onEntry(entry: LibraryEntry): void;
  onStatus?(status: GistStatus): void;
  onReviewUpdates(files: Array<{ name: string; text: string }>): void;
}) {
  const toast = useToast();
  const statusRpc = useRpc(gistStatus);
  const inspectRpc = useRpc(inspectGist);
  const linkPreviewRpc = useRpc(gistLinkPreview);
  const linkCommitRpc = useWriteRpc(gistLinkCommit);
  const publishPreviewRpc = useRpc(gistPublishPreview);
  const publishCommitRpc = useWriteRpc(gistPublishCommit);
  const operationRpc = useWriteRpc(gistPublishOperation);
  const unlinkRpc = useWriteRpc(gistUnlink);
  const readGistRpc = useRpc(readGist);
  const [status, setStatus] = useState<GistStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [publishReviewOpen, setPublishReviewOpen] = useState(false);
  const [unlinkConfirmOpen, setUnlinkConfirmOpen] = useState(false);
  const [gistUrl, setGistUrl] = useState("");
  const [inspection, setInspection] = useState<Awaited<ReturnType<typeof inspectRpc>> | null>(null);
  const [selectedFile, setSelectedFile] = useState("");
  const [newLinkFileName, setNewLinkFileName] = useState("");
  const [storage, setStorage] = useState<GistLinkStorage>("host");
  const [repository, setRepository] = useState("");
  const [newStorage, setNewStorage] = useState<GistLinkStorage>("host");
  const [newRepository, setNewRepository] = useState("");
  const [linkPreview, setLinkPreview] = useState<Awaited<ReturnType<typeof linkPreviewRpc>> | null>(
    null,
  );
  const [publishPreview, setPublishPreview] = useState<Awaited<
    ReturnType<typeof publishPreviewRpc>
  > | null>(null);
  const [publishMode, setPublishMode] = useState<"revision" | "new">("revision");
  const [newFileName, setNewFileName] = useState(`${safeFileName(entry.set.name)}.yaml`);
  const [description, setDescription] = useState("");
  const [publicGist, setPublicGist] = useState(false);
  const [newSetupOpen, setNewSetupOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const [operation, setOperation] = useState<GistOperation | null>(null);
  const [createdGistUrl, setCreatedGistUrl] = useState<string | null>(null);
  const [overwriteReviewed, setOverwriteReviewed] = useState(false);

  const colors = theme.colors;
  const text = { color: colors.foreground };
  const muted = { color: colors.foregroundMuted };
  const warning = { color: colors.statusWarning };
  const danger = { color: colors.statusDanger };
  const field = {
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    minHeight: 44,
    color: colors.foreground,
    borderColor: colors.border,
    backgroundColor: colors.surface1,
  };
  const startBusy = (action: string) => {
    setBusy(true);
    setBusyAction(action);
  };
  const endBusy = () => {
    setBusy(false);
    setBusyAction(null);
  };

  useEffect(() => {
    let current = true;
    if (initialStatus) {
      setStatus(initialStatus);
      setOperation(initialStatus.operation ?? null);
      return;
    }
    setStatus(null);
    void statusRpc({ libraryRoot, localIds: [entry.localId], check: false })
      .then(({ statuses }) => {
        if (!current) return;
        const found = statuses[0] ?? null;
        setStatus(found);
        setOperation(found?.operation ?? null);
        if (found) onStatus?.(found);
      })
      .catch((cause: unknown) => {
        if (current) setError(errorMessage(cause));
      });
    return () => {
      current = false;
    };
  }, [entry.localId, libraryRoot, initialStatus, statusRpc, onStatus]);

  const loadStatus = async (check: boolean) => {
    startBusy("check");
    setError(null);
    try {
      const { statuses } = await statusRpc({ libraryRoot, localIds: [entry.localId], check });
      const found = statuses[0] ?? null;
      setStatus(found);
      setOperation(found?.operation ?? null);
      if (found) onStatus?.(found);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      endBusy();
    }
  };

  const showLink = () => {
    setLinkOpen(true);
    setGistUrl("");
    setInspection(null);
    setSelectedFile("");
    setNewLinkFileName(`${safeFileName(entry.set.name)}.yaml`);
    setLinkPreview(null);
    setStorage(status?.storage ?? "host");
    setRepository(status?.repository ?? "");
    setError(null);
  };

  const checkGist = async () => {
    startBusy("inspect");
    setError(null);
    setInspection(null);
    setLinkPreview(null);
    try {
      const value = await inspectRpc({ libraryRoot, url: gistUrl.trim(), localId: entry.localId });
      setInspection(value);
      setSelectedFile(value.suggestedFile ?? "");
      setNewLinkFileName(`${safeFileName(entry.set.name)}.yaml`);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      endBusy();
    }
  };

  const previewLink = async () => {
    const fileName = selectedFile === "__new__" ? newLinkFileName.trim() : selectedFile;
    if (!inspection || !fileName) return;
    startBusy("preview-link");
    setError(null);
    try {
      const value = await linkPreviewRpc({
        libraryRoot,
        localId: entry.localId,
        expectedRevision: entry.revision,
        gistId: inspection.gist.id,
        fileName,
        storage,
        ...(storage === "repository" ? { repository } : {}),
      });
      setLinkPreview(value);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      endBusy();
    }
  };

  const commitLink = async () => {
    if (!linkPreview) return;
    startBusy("link");
    setError(null);
    try {
      const result = await linkCommitRpc({
        libraryRoot,
        previewId: linkPreview.previewId,
        confirmTarget: true,
      });
      onEntry(result.entry);
      setStatus(result.status);
      onStatus?.(result.status);
      setLinkOpen(false);
      setLinkPreview(null);
      toast.show("Gist linked. Nothing was sent to GitHub.", { variant: "success" });
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      endBusy();
    }
  };

  const openPublish = async (mode: "revision" | "new") => {
    setPublishMode(mode);
    setCreatedGistUrl(null);
    setPublishPreview(null);
    setError(null);
    setOverwriteReviewed(false);
    if (mode === "new") {
      setNewFileName(`${safeFileName(entry.set.name)}.yaml`);
      setDescription("");
      setNewStorage(status?.storage ?? "host");
      setNewRepository(status?.repository ?? "");
      setNewSetupOpen(true);
      return;
    }
    setPublishReviewOpen(true);
    await loadPublishPreview(mode);
  };

  const loadPublishPreview = async (mode: "revision" | "new") => {
    startBusy("prepare-publish");
    setError(null);
    setPublishPreview(null);
    setOperation(null);
    setOverwriteReviewed(false);
    try {
      const preview = await publishPreviewRpc({
        libraryRoot,
        localId: entry.localId,
        expectedRevision: entry.revision,
        mode,
        ...(mode === "new"
          ? {
              storage: newStorage,
              ...(newStorage === "repository" ? { repository: newRepository } : {}),
              fileName: newFileName,
              public: publicGist,
              description: description.trim() || undefined,
            }
          : {}),
      });
      setPublishPreview(preview);
      if (mode === "new") {
        setNewSetupOpen(false);
        setPublishReviewOpen(true);
      }
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      endBusy();
    }
  };

  const commitPublish = async (action: string) => {
    if (!publishPreview) return;
    startBusy("publish");
    setError(null);
    try {
      const result = await publishCommitRpc({
        libraryRoot,
        previewId: publishPreview.previewId,
        overwriteRemote: action === "overwrite",
        confirmTarget:
          publishPreview.requiresTargetConfirmation ||
          action === "publish-new" ||
          action === "overwrite",
        refreshBaselineOnly: action === "refresh-baseline",
      });
      if (result.entry) onEntry(result.entry);
      if (result.status) {
        setStatus(result.status);
        onStatus?.(result.status);
      }
      if (result.operation) setOperation(result.operation);
      if (publishMode === "new" && result.gist?.url) setCreatedGistUrl(result.gist.url);
      if (result.outcome === "remote-changed") {
        setPublishPreview(null);
        setOverwriteReviewed(false);
        toast.show(
          "The Gist changed since this review. Review the latest changes before publishing.",
          { variant: "info" },
        );
        await openPublish(publishMode);
      } else if (result.outcome === "rejected") {
        setPublishPreview(null);
        setError(
          result.message || "GitHub rejected this publish. Review the reason and try again.",
        );
      } else if (
        result.outcome === "outcome-unknown" ||
        result.outcome === "link-embedding-unfinished" ||
        result.outcome === "partial-local-save"
      ) {
        setPublishPreview(null);
        setPublishReviewOpen(false);
        toast.show(result.message, { variant: "warning" });
      } else {
        setPublishPreview(null);
        setPublishReviewOpen(false);
        toast.show(result.message, { variant: "success" });
      }
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      endBusy();
    }
  };

  const reviewUpdates = async (
    fileName = status?.pointer?.fileName,
    url = status?.remote?.url ?? status?.url,
  ) => {
    if (!fileName || !url) return;
    startBusy("review-updates");
    setError(null);
    try {
      const { files } = await readGistRpc({ url, fileName });
      const fileValue = files.find((fileItem) => fileItem.name === fileName);
      if (!fileValue) throw new Error(`The linked file ${fileName} is no longer in this Gist.`);
      onReviewUpdates([{ name: fileValue.name, text: fileValue.text }]);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      endBusy();
    }
  };

  const reconcileOperation = async (
    action: "check" | "finish" | "adopt" | "dismiss" = "check",
    gistId?: string,
    acceptDuplicateRisk = false,
  ) => {
    if (!operation) return;
    startBusy("operation");
    setError(null);
    try {
      const result = await operationRpc({
        libraryRoot,
        operationId: operation.id,
        action,
        ...(gistId ? { gistId } : {}),
        ...(acceptDuplicateRisk ? { acceptDuplicateRisk: true } : {}),
      });
      setOperation(result.operation);
      if (result.status) {
        setStatus(result.status);
        onStatus?.(result.status);
      }
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      endBusy();
    }
  };

  const unlink = async () => {
    if (!status?.pointer) return;
    startBusy("unlink");
    setError(null);
    try {
      const result = await unlinkRpc({
        libraryRoot,
        localId: entry.localId,
        expectedRevision: entry.revision,
      });
      onEntry(result.entry);
      setStatus(result.status);
      onStatus?.(result.status);
      toast.show("Gist link removed. The Gist remains online.", { variant: "success" });
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      endBusy();
    }
  };

  const publishActions = publishPreview?.actions ?? [];
  const unresolvedOperation = [operation, status?.operation].some(
    (item) => !!item && item.phase !== "complete" && item.phase !== "dismissed",
  );
  const visibility = status?.remote ? (status.remote.public ? "public" : "secret") : "unknown";
  const statusText = statusLabel(status);

  return (
    <>
      <SettingsSection
        title="GitHub Gist"
        info={`Publishes this saved pack to GitHub using the account on ${hostName}. Paseo's current profiles remain unchanged. The Gist link is saved ${linkLocation(status?.storage)}.`}
      >
        <SettingsCard>
          {status?.pointer ? (
            <GistAccountSummary
              hostName={hostName}
              accountLogin={status.account?.login ?? null}
              ownerLogin={status.remote?.owner.login ?? null}
              gistId={status.pointer.gistId}
              fileName={status.pointer.fileName}
              visibility={visibility}
              canPublish={ownershipCanPublish(status.ownership)}
              theme={theme}
            />
          ) : (
            <View style={{ paddingHorizontal: 16, paddingVertical: 8, gap: 8 }}>
              <Text style={text}>
                {status?.state === "link-conflict" ? "Gist link conflict" : "No Gist linked"}
              </Text>
              <Text style={muted}>
                {status?.state === "link-conflict"
                  ? "Several saved locations point to different Gists. Choose and confirm one before publishing."
                  : "Link an existing Gist for updates or publish this pack as a new Gist."}
              </Text>
            </View>
          )}
          {status?.state !== "unlinked" ? (
            <View style={{ paddingHorizontal: 16, paddingBottom: 8, gap: 6 }}>
              <Text style={muted}>{statusText}</Text>
              {status?.lastCheckedAt ? (
                <Text style={muted}>Last checked {formatTime(status.lastCheckedAt)}</Text>
              ) : null}
              {status?.blockers.map((blocker) => (
                <Text key={blocker.code} style={danger}>
                  Blocked: {blocker.message}
                </Text>
              ))}
              {status?.checkError ? (
                <Text style={danger}>Check GitHub account: {status.checkError.message}</Text>
              ) : null}
            </View>
          ) : null}
          {publishMode === "new" && createdGistUrl ? (
            <>
              <View style={{ paddingHorizontal: 16, paddingVertical: 8, gap: 8 }}>
                <Text style={{ color: colors.foreground, fontWeight: "600" }}>
                  New Gist created
                </Text>
                <Text selectable numberOfLines={2} ellipsizeMode="middle" style={muted}>
                  {createdGistUrl}
                </Text>
              </View>
              <ActionRow
                label="Copy the new Gist URL"
                actionLabel="Copy URL"
                disabled={busy}
                onPress={() =>
                  void copyText(createdGistUrl).then(() =>
                    toast.show("Gist URL copied.", { variant: "success" }),
                  )
                }
              />
            </>
          ) : null}
          {status?.pointer ? (
            <>
              {status.ownership !== "not-owner" ? (
                <ActionRow
                  label="Publish the saved pack to this Gist"
                  hint={
                    status.ownership === "unknown"
                      ? "GitHub account ownership will be checked in the review."
                      : status.state === "up-to-date"
                        ? "No changes to publish."
                        : undefined
                  }
                  actionLabel={
                    busyAction === "prepare-publish" ? "Preparing…" : "Publish revision…"
                  }
                  disabled={
                    disabled ||
                    busy ||
                    unresolvedOperation ||
                    (status.ownership === "owner" && status.state === "up-to-date")
                  }
                  onPress={() => void openPublish("revision")}
                />
              ) : null}
              {status.ownership === "not-owner" ? (
                <ActionRow
                  label="Review updates from this Gist"
                  actionLabel={busyAction === "review-updates" ? "Reading…" : "Review updates"}
                  disabled={disabled || busy}
                  onPress={() => void reviewUpdates()}
                />
              ) : null}
              <ActionRow
                label="Check GitHub for updates"
                actionLabel={busyAction === "check" ? "Checking…" : "Check"}
                disabled={disabled || busy}
                onPress={() => void loadStatus(true)}
              />
              {status.url ? (
                <ActionRow
                  label="Gist history on GitHub"
                  actionLabel="Open"
                  disabled={busy}
                  onPress={() => {
                    const url = status.url;
                    if (url) void openExternalUrl(url);
                  }}
                />
              ) : null}
              {status.ownership === "not-owner" ? (
                <View style={{ paddingHorizontal: 16, paddingVertical: 6 }}>
                  <Text style={muted}>
                    Ask @{status.remote?.owner.login ?? "the owner"} to publish, or publish a new
                    Gist.
                  </Text>
                </View>
              ) : null}
              <ActionRow
                label="Manage this Gist link"
                actionLabel={manageOpen ? "Close" : "Manage…"}
                disabled={busy}
                onPress={() => setManageOpen((open) => !open)}
              />
              {manageOpen ? (
                <View>
                  <ActionRow
                    label="Publish this pack as a new Gist"
                    actionLabel={
                      busyAction === "prepare-publish" ? "Preparing…" : "Publish as new Gist…"
                    }
                    disabled={disabled || busy || unresolvedOperation}
                    onPress={() => void openPublish("new")}
                  />
                  <ActionRow
                    label="Link an existing Gist"
                    actionLabel="Link Gist…"
                    disabled={disabled || busy}
                    onPress={showLink}
                  />
                  <ActionRow
                    label="Remove this pack's Gist link"
                    actionLabel="Unlink"
                    disabled={busy || disabled}
                    onPress={() => setUnlinkConfirmOpen(true)}
                  />
                  {status.locations.map((location) => (
                    <View
                      key={`${location.location}:${location.path ?? location.pointer?.gistId ?? "none"}`}
                      style={{ paddingHorizontal: 16, paddingVertical: 4 }}
                    >
                      <Text selectable numberOfLines={2} ellipsizeMode="middle" style={muted}>
                        {locationLabel(location)}
                      </Text>
                    </View>
                  ))}
                  {status.previous.map((item) => (
                    <ActionRow
                      key={`${item.gistId}-${item.fileName}-${item.replacedAt}`}
                      label={`Previous Gist · ${item.fileName} · ${item.gistId.slice(0, 8)}`}
                      hint="This Gist remains online."
                      actionLabel="Copy URL"
                      disabled={!item.url}
                      onPress={() =>
                        item.url &&
                        void copyText(item.url).then(() =>
                          toast.show("Gist URL copied.", { variant: "success" }),
                        )
                      }
                    />
                  ))}
                </View>
              ) : null}
            </>
          ) : (
            <>
              <ActionRow
                label="Link an existing Gist"
                actionLabel="Link Gist…"
                disabled={disabled || busy}
                onPress={showLink}
              />
              <ActionRow
                label="Publish this pack as a new Gist"
                actionLabel={
                  busyAction === "prepare-publish" ? "Preparing…" : "Publish as new Gist…"
                }
                disabled={disabled || busy || unresolvedOperation}
                onPress={() => void openPublish("new")}
              />
            </>
          )}
          {operation && operation.phase !== "complete" ? (
            <View style={{ gap: 8 }}>
              <View style={{ paddingHorizontal: 16, paddingVertical: 8, gap: 8 }}>
                <Text style={warning}>Warning: {operation.message}</Text>
                {operation.evidence?.matches ? (
                  <Text style={muted}>Your changes are present on GitHub.</Text>
                ) : operation.phase === "outcome-unknown" ? (
                  <Text style={muted}>
                    Different current content cannot prove whether the earlier write succeeded; a
                    later edit may have replaced it.
                  </Text>
                ) : null}
              </View>
              {operation.nextActions.includes("check") ? (
                <ActionRow
                  label="Check whether GitHub saved your publish"
                  actionLabel={busy ? "Checking…" : "Check again"}
                  disabled={busy}
                  onPress={() => void reconcileOperation("check")}
                />
              ) : null}
              {operation.nextActions.includes("finish") ? (
                <ActionRow
                  label="Finish saving the new Gist link"
                  actionLabel={busy ? "Finishing…" : "Finish linking"}
                  disabled={busy}
                  onPress={() => void reconcileOperation("finish")}
                />
              ) : null}
              {operation.nextActions.includes("adopt")
                ? operation.candidates.map((candidate) => (
                    <ActionRow
                      key={candidate.gistId}
                      label={`Matching Gist found · ${candidate.updatedAt ?? candidate.gistId}`}
                      actionLabel="Link this Gist"
                      disabled={busy}
                      onPress={() => void reconcileOperation("adopt", candidate.gistId)}
                    />
                  ))
                : null}
              {operation.nextActions.includes("dismiss") ? (
                <ActionRow
                  label={
                    operation.kind === "revision"
                      ? "Stop checking for this file update"
                      : "Stop checking for the uncertain Gist"
                  }
                  hint={
                    operation.kind === "revision"
                      ? "Publishing again may overwrite a later edit to the Gist file."
                      : "Publishing again may create a duplicate Gist."
                  }
                  actionLabel="Stop checking"
                  disabled={busy}
                  onPress={() => void reconcileOperation("dismiss", undefined, true)}
                />
              ) : null}
              {operation.gist?.url ? (
                <ActionRow
                  label="View this Gist on GitHub"
                  actionLabel="Open"
                  disabled={busy}
                  onPress={() => {
                    const url = operation.gist?.url;
                    if (url) void openExternalUrl(url);
                  }}
                />
              ) : null}
              <ActionRow
                label="Close this operation message"
                actionLabel="Close"
                disabled={busy}
                onPress={() => setOperation(null)}
              />
            </View>
          ) : null}
        </SettingsCard>
      </SettingsSection>
      {error ? (
        <Text accessibilityRole="alert" style={danger}>
          {error}
        </Text>
      ) : null}

      <Modal
        title="Link Gist"
        open={linkOpen}
        onOpenChange={(open) => {
          if (!open && !busy) {
            setLinkOpen(false);
            setLinkPreview(null);
          }
        }}
      >
        <Modal.Content scrollable={false} contentContainerStyle={{ padding: 16, gap: 12 }}>
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 12 }}>
            <Text style={muted}>
              Paseo host: {hostName}
              {inspection ? ` · GitHub account: @${inspection.account.login}` : ""}
            </Text>
            {error ? (
              <Text accessibilityRole="alert" style={danger}>
                {error}
              </Text>
            ) : null}
            <View style={{ padding: 16, gap: 8 }}>
              <TextInput
                accessibilityLabel="GitHub Gist URL"
                placeholder="https://gist.github.com/owner/id"
                placeholderTextColor={colors.foregroundMuted}
                value={gistUrl}
                onChangeText={(value) => {
                  setGistUrl(value);
                  setInspection(null);
                  setSelectedFile("");
                  setLinkPreview(null);
                }}
                editable={!busy && !linkPreview}
                autoCapitalize="none"
                autoCorrect={false}
                style={field}
              />
            </View>
            <ActionRow
              label="Check this Gist"
              actionLabel={busy ? "Checking…" : "Check Gist"}
              disabled={busy || !gistUrl.trim()}
              onPress={() => void checkGist()}
            />
            {inspection ? (
              <SettingsSection title="Choose a profile-pack file">
                <SettingsCard>
                  <View style={{ padding: 16, gap: 8 }}>
                    <Text style={muted}>
                      Owner @{inspection.gist.owner.login} ·{" "}
                      {inspection.gist.public ? "Public" : "Secret"}
                      {inspection.ownership === "not-owner" ? " · Read-only for this account" : ""}
                    </Text>
                  </View>
                  <SettingsSelect
                    label="Choose the file for this profile pack"
                    value={selectedFile}
                    options={[
                      { label: "Select a YAML file", value: "" },
                      ...inspection.files
                        .filter((fileItem) => fileItem.linkable)
                        .map((fileItem) => ({
                          label: `${fileItem.name}${fileItem.matchesPack ? " · Same pack ID" : ""}`,
                          value: fileItem.name,
                        })),
                      ...(inspection.ownership === "owner"
                        ? [{ label: "Add a new YAML file", value: "__new__" }]
                        : []),
                    ]}
                    disabled={busy || !!linkPreview}
                    onValueChange={(value) => {
                      setSelectedFile(value);
                      setLinkPreview(null);
                    }}
                  />
                  {selectedFile === "__new__" ? (
                    <View style={{ paddingHorizontal: 16, paddingVertical: 8 }}>
                      <Text style={text}>File name to add</Text>
                      <TextInput
                        accessibilityLabel="New YAML file name in this Gist"
                        placeholder="profile-pack.yaml"
                        placeholderTextColor={colors.foregroundMuted}
                        value={newLinkFileName}
                        onChangeText={(value) => {
                          setNewLinkFileName(value);
                          setLinkPreview(null);
                        }}
                        editable={!busy && !linkPreview}
                        autoCapitalize="none"
                        autoCorrect={false}
                        style={field}
                      />
                    </View>
                  ) : null}
                  <GistLinkStorageSelector
                    value={storage}
                    onChange={(next) => {
                      setStorage(next);
                      if (next === "repository" && !repository) setRepository(libraryRoot);
                    }}
                    repositoryPath={repository}
                    onRepositoryPathChange={setRepository}
                    defaultRepositoryPath={libraryRoot}
                    sidecarPath={linkPreview?.destination}
                    portableVersionHint={PORTABLE_LINK_MIN_PLUGIN_VERSION}
                    visibility={inspection.gist.public ? "public" : "secret"}
                    disabled={busy || !!linkPreview}
                    theme={theme}
                  />
                  {linkPreview ? (
                    <View style={{ padding: 16, gap: 8 }}>
                      {linkPreview.destination ? (
                        <Text selectable numberOfLines={2} ellipsizeMode="middle" style={muted}>
                          This host will save the link at {linkPreview.destination}.
                        </Text>
                      ) : null}
                      {linkPreview.pendingFirstPublish ? (
                        <Text style={warning}>
                          Warning: Pending first publish: this file will be added only after you
                          review a publish.
                        </Text>
                      ) : null}
                      {linkPreview.warnings.map((warningText) => (
                        <Text key={warningText} style={warning}>
                          Warning: {warningText}
                        </Text>
                      ))}
                      {linkPreview.comparison ? (
                        <GistNamedChanges
                          before={comparisonSet(linkPreview.comparison, entry.set, "before")}
                          after={comparisonSet(linkPreview.comparison, entry.set, "target")}
                          theme={theme}
                          label="Saved pack and Gist comparison"
                        />
                      ) : null}
                      <Text style={muted}>
                        Linking only saves this target on the selected location. Nothing is sent to
                        GitHub.
                      </Text>
                    </View>
                  ) : null}
                  {linkPreview ? (
                    <ActionRow
                      label="Change the inspected Gist, file, or storage location"
                      actionLabel="Edit choices"
                      disabled={busy}
                      onPress={() => setLinkPreview(null)}
                    />
                  ) : null}
                  <View style={{ gap: 8 }}>
                    <ActionRow
                      label="Preview this Gist link"
                      actionLabel={busy ? "Checking…" : "Review destination"}
                      disabled={
                        busy ||
                        !selectedFile ||
                        (selectedFile === "__new__" && !newLinkFileName.trim()) ||
                        linkPreview !== null
                      }
                      onPress={() => void previewLink()}
                    />
                    {linkPreview ? (
                      <ActionRow
                        label="Confirm the owner, file, and link location"
                        actionLabel={busy ? "Saving…" : "Link Gist"}
                        disabled={busy || linkPreview.blockers.length > 0}
                        onPress={() => void commitLink()}
                      />
                    ) : null}
                  </View>
                </SettingsCard>
              </SettingsSection>
            ) : null}
          </ScrollView>
        </Modal.Content>
      </Modal>

      <Modal
        title="Remove Gist link?"
        open={unlinkConfirmOpen}
        onOpenChange={(open) => {
          if (!open && !busy) setUnlinkConfirmOpen(false);
        }}
      >
        <Modal.Content contentContainerStyle={{ gap: 8 }}>
          <View style={{ padding: 16 }}>
            <Text style={text}>
              Remove this pack's active Gist link? The Gist and its history stay online.
            </Text>
          </View>
          <ActionRow
            label="Confirm removing the local link"
            actionLabel={busy ? "Removing…" : "Unlink"}
            disabled={busy}
            onPress={() => {
              setUnlinkConfirmOpen(false);
              void unlink();
            }}
          />
          <ActionRow
            label="Keep this Gist link"
            actionLabel="Cancel"
            disabled={busy}
            onPress={() => setUnlinkConfirmOpen(false)}
          />
        </Modal.Content>
      </Modal>

      <Modal
        title="Publish as a new Gist"
        open={newSetupOpen}
        onOpenChange={(open) => {
          if (!open && !busy) setNewSetupOpen(false);
        }}
      >
        <Modal.Content scrollable={false} contentContainerStyle={{ padding: 16, gap: 12 }}>
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 12 }}>
            <Text style={muted}>
              {status?.account?.login
                ? `Publish as @${status.account.login}.`
                : "The GitHub account on this host is checked in the review."}{" "}
              The new Gist becomes this pack's active link after confirmation.
            </Text>
            <View style={{ gap: 8 }}>
              <Text style={text}>File name</Text>
              <TextInput
                accessibilityLabel="New Gist file name"
                placeholder="profile-pack.yaml"
                placeholderTextColor={colors.foregroundMuted}
                value={newFileName}
                onChangeText={setNewFileName}
                editable={!busy}
                autoCapitalize="none"
                autoCorrect={false}
                style={field}
              />
              <Text style={text}>Description</Text>
              <TextInput
                accessibilityLabel="Gist description"
                placeholder="Optional"
                placeholderTextColor={colors.foregroundMuted}
                value={description}
                onChangeText={setDescription}
                editable={!busy}
                style={field}
              />
            </View>
            <SettingsSelect
              label="Visibility"
              value={publicGist ? "public" : "secret"}
              options={[
                { label: "Secret · anyone with its URL can read it", value: "secret" },
                { label: "Public", value: "public" },
              ]}
              disabled={busy}
              onValueChange={(value) => setPublicGist(value === "public")}
            />
            <SettingsSection title="Link storage">
              <SettingsCard>
                <GistLinkStorageSelector
                  value={newStorage}
                  onChange={(next) => {
                    setNewStorage(next);
                    if (next === "repository" && !newRepository) setNewRepository(libraryRoot);
                  }}
                  repositoryPath={newRepository}
                  onRepositoryPathChange={setNewRepository}
                  defaultRepositoryPath={libraryRoot}
                  portableVersionHint={PORTABLE_LINK_MIN_PLUGIN_VERSION}
                  visibility={publicGist ? "public" : "secret"}
                  disabled={busy}
                  theme={theme}
                />
              </SettingsCard>
            </SettingsSection>
            {status?.pointer ? (
              <Text style={muted}>
                The old Gist stays online; people using its URL will not receive these updates.
              </Text>
            ) : null}
            {error ? (
              <Text accessibilityRole="alert" style={danger}>
                {error}
              </Text>
            ) : null}
            <ActionRow
              label="Review new Gist and active-link change"
              actionLabel={busyAction === "prepare-publish" ? "Preparing…" : "Review publish"}
              disabled={busy || !newFileName.trim()}
              onPress={() => void loadPublishPreview("new")}
            />
          </ScrollView>
        </Modal.Content>
      </Modal>

      <Modal
        title={publishMode === "new" ? "Publish as a new Gist" : "Publish revision"}
        open={publishReviewOpen}
        onOpenChange={(open) => {
          if (!open && !busy) {
            setPublishPreview(null);
            setPublishReviewOpen(false);
          }
        }}
      >
        <Modal.Content scrollable={false} contentContainerStyle={{ padding: 16, gap: 12 }}>
          {publishPreview ? (
            <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 12 }}>
              <GistAccountSummary
                hostName={hostName}
                accountLogin={publishPreview.account.login}
                ownerLogin={publishPreview.target.ownerLogin ?? publishPreview.account.login}
                gistId={publishPreview.target.gistId ?? "New Gist"}
                fileName={publishPreview.target.fileName}
                visibility={publishPreview.target.public ? "public" : "secret"}
                canPublish={ownershipCanPublish(publishPreview.ownership)}
                theme={theme}
              />
              <View style={{ padding: 16, gap: 8 }}>
                <Text style={text}>
                  {publishMode === "new"
                    ? `Create ${publishPreview.target.public ? "a public" : "a secret"} Gist`
                    : `Update ${publishPreview.target.fileName}`}
                </Text>
                {publishMode === "revision" ? (
                  <Text style={muted}>
                    {publishPreview.otherFileCount} other Gist file
                    {publishPreview.otherFileCount === 1 ? " stays" : "s stay"} unchanged.
                  </Text>
                ) : null}
                {publishMode === "new" ? (
                  <Text style={muted}>
                    Description: {publishPreview.target.description || "None"}
                  </Text>
                ) : null}
                {publishPreview.twoStep ? (
                  <Text style={warning}>
                    Warning: This portable pack needs two steps. The new Gist link becomes active
                    only after its link is embedded and saved.
                  </Text>
                ) : null}
                {publishPreview.target.public ? null : (
                  <Text style={muted}>
                    Secret Gists can be read by anyone with the URL, including their history.
                  </Text>
                )}
                {publishPreview.warnings.map((warningText) => (
                  <Text key={warningText} style={warning}>
                    Warning: {warningText}
                  </Text>
                ))}
                {publishPreview.localChange && publishPreview.remoteChanged ? (
                  <GistNamedChanges
                    before={comparisonSet(publishPreview.localChange, entry.set, "before")}
                    after={comparisonSet(publishPreview.localChange, entry.set, "target")}
                    theme={theme}
                    label="Your changes"
                  />
                ) : null}
                {publishMode === "new" && !publishPreview.target.gistId ? (
                  <GistNamedChanges
                    before={emptySet(entry.set)}
                    after={entry.set}
                    theme={theme}
                    label="New Gist contents"
                  />
                ) : null}
                {publishPreview.remoteChange ? (
                  <GistNamedChanges
                    before={comparisonSet(publishPreview.remoteChange, entry.set, "before")}
                    after={comparisonSet(publishPreview.remoteChange, entry.set, "target")}
                    theme={theme}
                    label="Changes on GitHub"
                  />
                ) : null}
                {publishPreview.replace && publishMode === "revision" ? (
                  <GistNamedChanges
                    before={comparisonSet(publishPreview.replace, entry.set, "before")}
                    after={comparisonSet(publishPreview.replace, entry.set, "target")}
                    theme={theme}
                    label="Changes to Gist file when you publish"
                  />
                ) : null}
                {publishPreview.requiresOverwrite ? (
                  <Text style={warning}>
                    Warning: This file changed on GitHub. Publishing will replace its current
                    contents. A concurrent edit after the final check may also be overwritten.
                  </Text>
                ) : null}
                {publishMode === "revision" && !publishPreview.requiresOverwrite ? (
                  <Text style={muted}>
                    GitHub is checked again immediately before the update. An edit after that check
                    could be overwritten.
                  </Text>
                ) : null}
                {publishPreview.blockers.map((blocker) => (
                  <Text key={blocker.code} accessibilityRole="alert" style={danger}>
                    {blocker.message}
                  </Text>
                ))}
              </View>
              {publishActions.includes("review-updates") ||
              publishActions.includes("replace-saved-pack") ? (
                <ActionRow
                  label="Review replacing this saved pack with the Gist version"
                  actionLabel="Review updates"
                  disabled={busy}
                  onPress={() =>
                    void reviewUpdates(publishPreview.target.fileName, publishPreview.target.url)
                  }
                />
              ) : null}
              {publishActions.includes("refresh-baseline") ? (
                <ActionRow
                  label="GitHub already has this profile pack's contents"
                  hint="Nothing is uploaded. This records the pack as published."
                  actionLabel="Mark as published"
                  disabled={busy}
                  onPress={() => void commitPublish("refresh-baseline")}
                />
              ) : null}
              {publishActions.includes("publish-new") && publishMode === "revision" ? (
                <ActionRow
                  label="Publish as a new Gist and switch this pack's link"
                  actionLabel="Publish as new Gist…"
                  disabled={busy}
                  onPress={() => void openPublish("new")}
                />
              ) : null}
              {publishPreview.primaryAction === "publish" || publishActions.includes("publish") ? (
                <ActionRow
                  label="Publish this saved pack revision"
                  actionLabel={busyAction === "publish" ? "Publishing…" : "Publish revision"}
                  disabled={busy || publishPreview.blockers.length > 0}
                  onPress={() => void commitPublish("publish")}
                />
              ) : null}
              {publishActions.includes("overwrite") ? (
                <SettingsCard>
                  <SettingsSwitch
                    label="I reviewed the changes on GitHub and want to replace them"
                    hint="The Gist file will be replaced with this saved pack. A later edit may also be overwritten."
                    value={overwriteReviewed}
                    disabled={busy}
                    onValueChange={setOverwriteReviewed}
                  />
                </SettingsCard>
              ) : null}
              {publishActions.includes("overwrite") ? (
                <ActionRow
                  label="Replace the changed remote file with this saved pack"
                  actionLabel={busyAction === "publish" ? "Publishing…" : "Overwrite Gist file"}
                  disabled={busy || !overwriteReviewed || publishPreview.blockers.length > 0}
                  onPress={() => void commitPublish("overwrite")}
                />
              ) : null}
              {publishMode === "new" &&
              (publishActions.includes("publish-new") || publishActions.includes("publish")) ? (
                <ActionRow
                  label="Create a Gist and switch this pack's active link"
                  actionLabel={busyAction === "publish" ? "Publishing…" : "Publish and switch link"}
                  hint={
                    status?.pointer
                      ? "The old Gist stays online; people using its URL will not receive these updates."
                      : undefined
                  }
                  disabled={busy || publishPreview.blockers.length > 0}
                  onPress={() => void commitPublish("publish-new")}
                />
              ) : null}
              {publishPreview.alreadyEqual ? (
                <Text style={muted}>Already up to date. No GitHub write is needed.</Text>
              ) : null}
            </ScrollView>
          ) : error ? (
            <Text accessibilityRole="alert" style={danger}>
              {error}
            </Text>
          ) : busy ? (
            <Text style={muted}>Preparing publish review…</Text>
          ) : null}
        </Modal.Content>
      </Modal>
    </>
  );
}

function comparisonSet(
  comparison: GistComparison,
  fallback: ProfileSet,
  side: "before" | "target",
): ProfileSet {
  const content = side === "before" ? comparison.before : comparison.target;
  const name = comparison.nameChanged?.[side] ?? fallback.name;
  const appendSystemPrompt = comparison.systemPrompt?.[side] ?? fallback.appendSystemPrompt;
  return { ...fallback, name, appendSystemPrompt, profiles: content };
}

function emptySet(set: ProfileSet): ProfileSet {
  return { ...set, name: "", appendSystemPrompt: undefined, profiles: [] };
}

function statusLabel(status: GistStatus | null): string {
  if (!status) return "Loading saved Gist status…";
  if (status.operation?.phase === "outcome-unknown") return "Publish outcome unknown · Check again";
  if (status.operation?.phase === "gist-created-link-unfinished")
    return "Gist created · link not saved yet";
  switch (status.state) {
    case "unlinked":
      return "No Gist linked";
    case "link-conflict":
      return "Link conflict · choose the active target before publishing";
    case "needs-confirmation":
      return "Confirm this Gist link on this host";
    case "unresolved-operation":
      return "Publish outcome needs checking";
    case "pending-first-publish":
      return "Pending first publish";
    case "unpublished-changes":
      return "Unpublished changes";
    case "remote-changed":
      return "Gist changed · review updates";
    case "both-changed":
      return "Saved pack and Gist both changed";
    case "link-change":
      return "Link change to publish";
    case "baseline-refresh":
      return "GitHub already matches · mark as published";
    case "up-to-date":
      return "Up to date";
    case "check-github-account":
      return "Check GitHub account";
    case "check-failed":
      return "Could not check GitHub · status is unverified";
    case "blocked":
      return `Blocked: ${status.blockers[0]?.message ?? "Publishing is unavailable."}`;
  }
}

function ownershipCanPublish(ownership: GistStatus["ownership"]): boolean | null {
  if (ownership === "owner") return true;
  if (ownership === "not-owner") return false;
  return null;
}

function linkLocation(storage: GistStatus["storage"]): string {
  switch (storage) {
    case "host":
      return "on this Paseo host";
    case "repository":
      return "in the selected Git repository";
    case "portable":
      return "in the profile pack file";
    default:
      return "in the selected location";
  }
}

function locationLabel(location: GistStatus["locations"][number]): string {
  const savedAt =
    location.location === "host"
      ? "Link saved on this Paseo host"
      : location.location === "repository"
        ? `Link saved in Git repo${location.path ? ` · ${location.path}` : ""}`
        : "Link saved in this pack file";
  const pointer = location.pointer
    ? ` · ${location.pointer.gistId.slice(0, 8)}/${location.pointer.fileName}`
    : "";
  return `${savedAt}${pointer}${location.problem ? ` · ${location.problem}` : ""}`;
}

function safeFileName(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "profile-pack"
  );
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
