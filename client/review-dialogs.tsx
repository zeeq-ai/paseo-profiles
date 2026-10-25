import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { ScrollView, TextInput } from "@getpaseo/plugin/client/react-native";
import {
  SettingsCard,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import { Platform, Pressable, Text, View } from "react-native";
import { canonicalJson } from "../shared/canonical";
import type { LibraryEntry, Profile } from "../shared/set";
import { ActionRow } from "./action-row";
import type {
  ApplyDraft,
  ApplyPreviewState,
  ExportState,
  ImportDraft,
  SelectionChoice,
} from "./models";
import { ProfileAppearance } from "./profile-appearance";
import { ProfileDiffReview } from "./profile-diff-review";
import { SelectAllAction } from "./select-all-action";
import { SharedPromptReview } from "./shared-prompt-review";

const stack = { gap: 8 };
const field = { borderWidth: 1, borderRadius: 8, padding: 12, minHeight: 44 };
const multiline = { minHeight: 150, textAlignVertical: "top" as const };

function isSourcePackIdMatch(reason: string): boolean {
  return reason === "Matching source pack ID" || reason === "Matching source set ID";
}

function candidateReasonLabel(reason: string): string {
  if (isSourcePackIdMatch(reason)) return "Same source pack ID";
  if (reason === "Related source origin") return "Related source pack";
  return reason;
}

export function ImportReview({
  draft,
  entries,
  targetChanged,
  theme,
  onPatch,
  onRefreshTarget,
  onChooseFiles,
  onReadHostFile,
  gistAvailable,
  gistAvailabilityMessage,
  onReadGist,
  onPreview,
  onUpdateAndUse,
  onCommit,
}: {
  draft: ImportDraft;
  entries: LibraryEntry[];
  targetChanged: boolean;
  theme: PluginScreenProps["theme"];
  onPatch(update: Partial<ImportDraft>): void;
  onRefreshTarget(): void;
  onChooseFiles(): void;
  onReadHostFile(): void;
  gistAvailable: boolean;
  gistAvailabilityMessage: string;
  onReadGist(): void;
  onPreview(): void;
  onUpdateAndUse(): void;
  onCommit(withApply: boolean): void;
}) {
  const colors = theme.colors;
  const textStyle = { color: colors.foreground };
  const mutedStyle = { color: colors.foregroundMuted };
  const dangerStyle = { color: colors.statusDanger };
  const warningStyle = { color: colors.statusWarning };
  const selectedFiles = draft.files.length
    ? draft.files
    : draft.text.trim()
      ? [{ name: "pasted-profile-pack.yaml", text: draft.text }]
      : [];
  const target = draft.preview?.items[0]?.target;
  const needsLocalDecision =
    draft.preview?.items.some(
      (item) =>
        item.localChanges &&
        !item.sourceUnchanged &&
        canonicalJson(item.incoming) !== canonicalJson(item.target?.set),
    ) ?? false;
  const ambiguousItems =
    draft.mode === "match"
      ? (draft.preview?.items.filter(
          (item) =>
            !item.target &&
            item.candidates.filter(({ reason }) => isSourcePackIdMatch(reason)).length > 1,
        ) ?? [])
      : [];
  const hasAmbiguousCandidates = ambiguousItems.length > 0;
  const needsCandidateRepreview =
    draft.mode === "match" &&
    !!draft.targetLocalId &&
    (draft.previewSourceFileIndex !== draft.targetFileIndex ||
      !draft.preview?.items.some((item) => item.target?.localId === draft.targetLocalId));
  const hasExplicitMatchTarget = draft.mode === "match" && !!draft.targetLocalId;
  const canPreview =
    selectedFiles.length > 0 &&
    !!draft.root &&
    !draft.busy &&
    !targetChanged &&
    (draft.mode !== "update" || (selectedFiles.length === 1 && !!draft.targetLocalId)) &&
    (!hasExplicitMatchTarget ||
      (draft.targetFileIndex >= 0 && draft.targetFileIndex < selectedFiles.length));
  const canUpdateAndUse =
    !targetChanged &&
    (draft.mode === "update" || draft.mode === "match") &&
    draft.preview?.items.length === 1 &&
    !!target &&
    !!draft.preview &&
    (!needsLocalDecision || draft.replaceLocalChanges);
  const commitLabel = draft.busy
    ? "Saving…"
    : draft.preview?.items.length === 1
      ? target
        ? "Update saved pack"
        : draft.mode === "new"
          ? "Import as copy"
          : "Save new pack to library"
      : draft.mode === "new"
        ? `Import ${draft.preview?.items.length ?? 0} copies`
        : `Save ${draft.preview?.items.length ?? 0} matched packs`;
  return (
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={stack}>
      <Text style={mutedStyle}>Library folder: {draft.root || "Unresolved host folder"}</Text>
      {targetChanged ? (
        <View style={stack}>
          <Text style={warningStyle}>
            The selected host or configured folder changed since this import was prepared. Refresh
            the target and review again before saving. Your import source is retained.
          </Text>
          <ActionRow
            label="The library target changed"
            actionLabel={draft.busy ? "Refreshing…" : "Refresh"}
            disabled={draft.busy}
            onPress={onRefreshTarget}
          />
        </View>
      ) : null}
      <SettingsSection
        title="Choose import source"
        info="Each YAML or JSON file is one profile pack. Paseo configuration JSON contributes only agentProfiles."
      >
        <SettingsCard>
          {Platform.OS === "web" ? (
            <ActionRow
              label="Choose files from this device"
              actionLabel="Choose"
              disabled={draft.busy}
              onPress={onChooseFiles}
            />
          ) : null}
          <View style={{ padding: 16, gap: 10 }}>
            <Text style={mutedStyle}>
              {draft.files.length
                ? `Selected: ${draft.files.map(({ name }) => name).join(", ")}`
                : "Paste a profile-pack YAML or Paseo JSON document, or read a file on the host."}
            </Text>
            <TextInput
              accessibilityLabel="Paste YAML or JSON"
              placeholder="Paste YAML profile-pack or Paseo JSON configuration"
              placeholderTextColor={colors.foregroundMuted}
              multiline
              value={draft.text}
              onChangeText={(text) =>
                onPatch({
                  text,
                  files: [],
                  gistUrl: "",
                  targetFileIndex: -1,
                  targetLocalId: "",
                  previewSourceFileIndex: -1,
                  preview: null,
                  apply: null,
                  error: null,
                })
              }
              style={[
                field,
                textStyle,
                { borderColor: colors.border, backgroundColor: colors.surface1 },
                multiline,
              ]}
              editable={!draft.busy}
            />
            <TextInput
              accessibilityLabel="Host file path"
              placeholder="Host path to a YAML or JSON file"
              placeholderTextColor={colors.foregroundMuted}
              value={draft.hostPath}
              onChangeText={(hostPath) => onPatch({ hostPath, error: null })}
              style={[
                field,
                textStyle,
                { borderColor: colors.border, backgroundColor: colors.surface1 },
              ]}
              editable={!draft.busy}
            />
            <TextInput
              accessibilityLabel="GitHub Gist URL"
              placeholder="https://gist.github.com/owner/id"
              placeholderTextColor={colors.foregroundMuted}
              value={draft.gistUrl}
              onChangeText={(gistUrl) =>
                onPatch({
                  gistUrl,
                  files: [],
                  text: "",
                  targetFileIndex: -1,
                  targetLocalId: "",
                  previewSourceFileIndex: -1,
                  preview: null,
                  apply: null,
                  error: null,
                  result: null,
                })
              }
              style={[
                field,
                textStyle,
                { borderColor: colors.border, backgroundColor: colors.surface1 },
              ]}
              editable={!draft.busy}
            />
            <Text style={mutedStyle}>
              Only load Gists from sources you trust. Review the files before saving or applying;
              contents are imported as data and not executed.
            </Text>
          </View>
          <ActionRow
            label="Read a file from the Paseo host"
            actionLabel={draft.busy ? "Reading…" : "Read"}
            disabled={draft.busy || !draft.hostPath.trim()}
            onPress={onReadHostFile}
          />
          <ActionRow
            label="Load files from a trusted GitHub Gist"
            actionLabel={draft.busy ? "Loading…" : "Load gist"}
            hint={!gistAvailable ? gistAvailabilityMessage : undefined}
            disabled={draft.busy || !draft.gistUrl.trim() || !gistAvailable}
            onPress={onReadGist}
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="Import action">
        <SettingsCard>
          <SettingsSelect
            label="Library action"
            value={draft.mode}
            options={[
              { label: "Match source ID or create pack", value: "match" },
              { label: "Import as copy with new IDs", value: "new" },
              { label: "Update a selected pack", value: "update" },
            ]}
            disabled={draft.busy}
            onValueChange={(mode) =>
              onPatch({
                mode,
                targetLocalId: "",
                targetFileIndex: -1,
                previewSourceFileIndex: -1,
                preview: null,
                apply: null,
                error: null,
                result: null,
                replaceLocalChanges: false,
              })
            }
          />
          {draft.mode === "update" ? (
            <SettingsSelect
              label="Pack to update"
              hint="Choose the destination explicitly. The preview compares incoming contents with this saved pack and its import baseline."
              value={draft.targetLocalId}
              options={[
                { label: "Choose a profile pack", value: "" },
                ...entries.map(({ localId, set }) => ({
                  label: `${set.name} · ${set.profiles.length} profiles`,
                  value: localId,
                })),
              ]}
              disabled={draft.busy || entries.length === 0}
              onValueChange={(targetLocalId) =>
                onPatch({
                  targetLocalId,
                  targetFileIndex: -1,
                  previewSourceFileIndex: -1,
                  preview: null,
                  apply: null,
                  error: null,
                  result: null,
                  replaceLocalChanges: false,
                })
              }
            />
          ) : null}
          <ActionRow
            label={
              draft.busy
                ? "Preparing preview…"
                : draft.mode === "match" && draft.targetLocalId
                  ? "Preview chosen target"
                  : "Preview import"
            }
            actionLabel="Preview"
            disabled={!canPreview}
            onPress={onPreview}
          />
        </SettingsCard>
      </SettingsSection>

      {draft.preview ? (
        <SettingsSection
          title="Import review"
          info={
            draft.mode === "new"
              ? "New copies receive fresh portable identities. This does not change Paseo."
              : "Review all incoming changes before updating the selected library entry."
          }
        >
          <SettingsCard>
            {draft.preview.items.map((item) => (
              <View key={`${item.index}:${item.fileName}`}>
                <View style={{ ...stack, paddingHorizontal: 16, paddingVertical: 12 }}>
                  <Text style={[textStyle, { fontWeight: "700" }]}>
                    {item.fileName} → {item.incoming.name}
                  </Text>
                  {item.target ? (
                    <Text style={mutedStyle}>Target pack: {item.target.set.name}</Text>
                  ) : null}
                  {item.target && item.target.set.name !== item.incoming.name ? (
                    <Text style={mutedStyle}>
                      Pack name: {item.target.set.name} → {item.incoming.name}
                    </Text>
                  ) : null}
                  {item.message ? (
                    <Text style={item.localChanges ? warningStyle : mutedStyle}>
                      {item.message}
                    </Text>
                  ) : null}
                  {item.sourceUnchanged && item.localChanges ? (
                    <Text style={warningStyle}>Source unchanged; local changes retained.</Text>
                  ) : null}
                  {item.localChanges &&
                  !item.sourceUnchanged &&
                  canonicalJson(item.incoming) !== canonicalJson(item.target?.set) ? (
                    <Text style={warningStyle}>
                      This pack has local edits that differ from the incoming version.
                    </Text>
                  ) : null}
                  <ProfileDiffReview
                    before={
                      item.sourceUnchanged && item.localChanges
                        ? item.incoming.profiles
                        : (item.target?.set.profiles ?? [])
                    }
                    after={
                      item.sourceUnchanged && item.localChanges
                        ? (item.target?.set.profiles ?? [])
                        : item.incoming.profiles
                    }
                    theme={theme}
                    label={
                      item.sourceUnchanged && item.localChanges
                        ? "Local edits retained"
                        : "Incoming profile changes"
                    }
                  />
                  <SharedPromptReview
                    before={
                      item.sourceUnchanged && item.localChanges
                        ? item.incoming.appendSystemPrompt
                        : item.target?.set.appendSystemPrompt
                    }
                    after={
                      item.sourceUnchanged && item.localChanges
                        ? item.target?.set.appendSystemPrompt
                        : item.incoming.appendSystemPrompt
                    }
                    theme={theme}
                  />
                  {item.candidates.length ? (
                    <Text style={mutedStyle}>
                      Possible targets:{" "}
                      {item.candidates
                        .map(({ name, reason }) => `${name} (${candidateReasonLabel(reason)})`)
                        .join(", ")}
                    </Text>
                  ) : null}
                </View>
                {draft.mode === "match" &&
                item.candidates.filter(({ reason }) => isSourcePackIdMatch(reason)).length > 1 ? (
                  <SettingsSelect
                    label="Choose a source-ID match"
                    hint="Several saved packs have this ID. Choose one to review that file alone."
                    value={
                      draft.targetLocalId &&
                      (draft.targetFileIndex === item.index ||
                        (draft.previewSourceFileIndex === draft.targetFileIndex &&
                          draft.preview?.items.length === 1 &&
                          item.target?.localId === draft.targetLocalId))
                        ? draft.targetLocalId
                        : ""
                    }
                    options={[
                      { label: "Choose a destination", value: "" },
                      ...item.candidates
                        .filter(({ reason }) => isSourcePackIdMatch(reason))
                        .map(({ localId, name }) => ({ label: name, value: localId })),
                    ]}
                    disabled={draft.busy}
                    onValueChange={(targetLocalId) =>
                      onPatch({
                        targetLocalId,
                        targetFileIndex: targetLocalId ? item.index : -1,
                        apply: null,
                        error: null,
                      })
                    }
                  />
                ) : null}
              </View>
            ))}
            {needsLocalDecision ? (
              <Pressable
                accessibilityRole="checkbox"
                accessibilityState={{ checked: draft.replaceLocalChanges }}
                onPress={() =>
                  onPatch({ replaceLocalChanges: !draft.replaceLocalChanges, apply: null })
                }
                style={{ paddingHorizontal: 16, paddingVertical: 10 }}
              >
                <Text style={textStyle}>
                  {draft.replaceLocalChanges ? "☑" : "☐"} Replace local changes
                </Text>
              </Pressable>
            ) : null}
            {hasAmbiguousCandidates ? (
              <View style={{ paddingHorizontal: 16, paddingVertical: 8 }}>
                <Text style={warningStyle}>
                  A source ID matches several saved packs. Choose a destination for one file and
                  preview it alone, or import the batch as copies.
                </Text>
              </View>
            ) : null}
            {needsCandidateRepreview ? (
              <View style={{ paddingHorizontal: 16, paddingVertical: 8 }}>
                <Text style={warningStyle}>
                  Preview the selected source file and destination before saving.
                </Text>
              </View>
            ) : null}
            <View style={stack}>
              <ActionRow
                label={commitLabel}
                actionLabel={draft.busy ? "Saving…" : "Save"}
                hint={
                  needsCandidateRepreview
                    ? "Preview the chosen target before committing."
                    : undefined
                }
                disabled={
                  draft.busy ||
                  targetChanged ||
                  (needsLocalDecision && !draft.replaceLocalChanges) ||
                  hasAmbiguousCandidates ||
                  needsCandidateRepreview
                }
                onPress={() => onCommit(false)}
              />
              {(draft.mode === "update" || draft.mode === "match") &&
              draft.preview.items.length === 1 &&
              target ? (
                <ActionRow
                  label={draft.busy ? "Preparing apply review…" : "Review Update and use"}
                  actionLabel="Review"
                  disabled={draft.busy || !canUpdateAndUse}
                  onPress={onUpdateAndUse}
                />
              ) : null}
            </View>
            {draft.apply ? (
              <View style={stack}>
                <View style={{ paddingHorizontal: 16, paddingVertical: 12, gap: 8 }}>
                  <Text style={warningStyle}>
                    Update and use replaces the complete current agent-profile list with the
                    reviewed target below.
                  </Text>
                  <ApplyReviewSummary preview={draft.apply} theme={theme} completeTarget />
                </View>
                <ActionRow
                  label={
                    draft.busy
                      ? "Updating and applying…"
                      : "Update library and replace current profiles"
                  }
                  actionLabel={draft.busy ? "Saving…" : "Update & use"}
                  disabled={
                    draft.busy ||
                    targetChanged ||
                    (needsLocalDecision && !draft.replaceLocalChanges)
                  }
                  onPress={() => onCommit(true)}
                />
              </View>
            ) : null}
          </SettingsCard>
        </SettingsSection>
      ) : null}
      {draft.result ? (
        <Text style={draft.error ? warningStyle : { color: colors.statusSuccess }}>
          {draft.result}
        </Text>
      ) : null}
      {draft.error ? (
        <Text accessibilityRole="alert" style={dangerStyle}>
          {draft.error}
        </Text>
      ) : null}
    </ScrollView>
  );
}

export function ApplyReview({
  draft,
  profiles,
  currentProfiles,
  sourceLabel,
  theme,
  onPatch,
  targetChanged,
  onRefreshTarget,
  onReview,
  onConfirm,
  defaultChoices,
}: {
  draft: ApplyDraft;
  profiles: Profile[];
  currentProfiles: Profile[];
  sourceLabel: string;
  theme: PluginScreenProps["theme"];
  targetChanged: boolean;
  onPatch(update: Partial<ApplyDraft>): void;
  onRefreshTarget(): void;
  onReview(): void;
  onConfirm(): void;
  defaultChoices(profiles: Profile[]): Record<string, SelectionChoice>;
}) {
  const { colors } = theme;
  const textStyle = { color: colors.foreground };
  const mutedStyle = { color: colors.foregroundMuted };
  const warningStyle = { color: colors.statusWarning };
  const dangerStyle = { color: colors.statusDanger };
  const selectedProfiles = profiles.filter(({ id }) => draft.selected.includes(id));
  const unresolvedReplacement =
    draft.mode === "add" &&
    selectedProfiles.some((profile) => {
      const choice = draft.choices[profile.id] ?? defaultChoices([profile])[profile.id];
      return (
        choice.action === "replace" &&
        (!choice.targetId || !currentProfiles.some(({ id }) => id === choice.targetId))
      );
    });
  const selectionsReady =
    (draft.mode !== "add" || selectedProfiles.length > 0) && !unresolvedReplacement;
  return (
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={stack}>
      <Text style={mutedStyle}>Source: {sourceLabel}</Text>
      {targetChanged ? (
        <View style={stack}>
          <Text style={warningStyle}>
            The selected host or configured folder changed since this review was prepared. Applying
            is paused until the target is refreshed and reviewed again.
          </Text>
          <ActionRow
            label="The library target changed"
            actionLabel={draft.busy ? "Refreshing…" : "Refresh"}
            disabled={draft.busy}
            onPress={onRefreshTarget}
          />
        </View>
      ) : null}
      {draft.mode === "use" ? (
        <Text style={warningStyle}>
          Use pack replaces the entire ordered agent-profile list. Add selected keeps unrelated
          profiles.
        </Text>
      ) : null}
      {draft.mode === "restore" ? (
        <Text style={warningStyle}>
          This restores a previous current-profile snapshot after review of the complete resulting
          list.
        </Text>
      ) : null}
      {draft.kind === "set" && draft.appendSystemPrompt !== undefined ? (
        <SettingsCard>
          <SettingsSwitch
            label={
              draft.appendSystemPrompt === ""
                ? "Clear shared system prompt"
                : "Apply pack's shared system prompt"
            }
            hint="Shared by agents on this host; takes effect when sessions start or restart."
            value={draft.applySystemPrompt ?? draft.mode === "use"}
            disabled={draft.busy || targetChanged}
            onValueChange={(applySystemPrompt) => onPatch({ applySystemPrompt, preview: null })}
          />
        </SettingsCard>
      ) : null}
      {draft.mode === "add" ? (
        <SettingsSection
          title="Select profiles and collision actions"
          info="Unselected profiles are skipped. Exact duplicates default to Skip; same-ID differences default to Keep both."
        >
          <SettingsCard>
            <SelectAllAction
              ids={profiles.map((profile) => profile.id)}
              selected={draft.selected}
              disabled={draft.busy || targetChanged}
              onChange={(selected) => onPatch({ selected, preview: null })}
            />
            {profiles.map((profile) => {
              const selected = draft.selected.includes(profile.id);
              const choice = draft.choices[profile.id] ?? defaultChoices([profile])[profile.id];
              const targets = currentProfiles.map((item) => ({
                label: `${item.name || item.id} · ${item.id}`,
                value: item.id,
              }));
              return (
                <View
                  key={profile.id}
                  style={{
                    paddingVertical: 8,
                    borderBottomWidth: 1,
                    borderColor: colors.border,
                    gap: 8,
                  }}
                >
                  <Pressable
                    accessibilityRole="checkbox"
                    accessibilityState={{
                      checked: selected,
                      disabled: draft.busy || targetChanged,
                    }}
                    disabled={draft.busy || targetChanged}
                    onPress={() =>
                      onPatch({
                        selected: selected
                          ? draft.selected.filter((id) => id !== profile.id)
                          : [...draft.selected, profile.id],
                        preview: null,
                      })
                    }
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 12,
                      paddingHorizontal: 16,
                      paddingVertical: 8,
                    }}
                  >
                    <Text style={textStyle}>{selected ? "☑" : "☐"}</Text>
                    <View style={{ flex: 1 }}>
                      <Text style={textStyle}>{profile.name || profile.id}</Text>
                      <Text style={mutedStyle}>
                        {profile.provider || "Automatic provider"}
                        {profile.model ? ` · ${profile.model}` : ""} · {profile.id}
                      </Text>
                      <ProfileAppearance profile={profile} theme={theme} />
                    </View>
                  </Pressable>
                  {selected ? (
                    <>
                      <SettingsSelect
                        label="When adding this profile"
                        disabled={draft.busy || targetChanged}
                        value={choice.action}
                        options={[
                          { label: "Add profile", value: "add" },
                          { label: "Skip profile", value: "skip" },
                          { label: "Keep both", value: "keep-both" },
                          { label: "Replace a current profile", value: "replace" },
                        ]}
                        onValueChange={(action) =>
                          onPatch({
                            choices: { ...draft.choices, [profile.id]: { action } },
                            preview: null,
                          })
                        }
                      />
                      {choice.action === "replace" ? (
                        <SettingsSelect
                          label="Current profile to replace"
                          value={choice.targetId ?? ""}
                          options={[{ label: "Choose current profile", value: "" }, ...targets]}
                          disabled={draft.busy || targetChanged || targets.length === 0}
                          onValueChange={(targetId) =>
                            onPatch({
                              choices: { ...draft.choices, [profile.id]: { ...choice, targetId } },
                              preview: null,
                            })
                          }
                        />
                      ) : null}
                    </>
                  ) : null}
                </View>
              );
            })}
          </SettingsCard>
          {unresolvedReplacement ? (
            <Text style={warningStyle}>
              Choose a current profile to replace before previewing these changes.
            </Text>
          ) : null}
        </SettingsSection>
      ) : null}
      <ActionRow
        label={draft.busy ? "Preparing review…" : "Preview changes"}
        actionLabel="Preview"
        disabled={draft.busy || targetChanged || !selectionsReady}
        onPress={onReview}
      />
      {draft.preview ? (
        <>
          <ApplyReviewSummary
            preview={draft.preview}
            theme={theme}
            completeTarget={draft.mode !== "add"}
          />
          <ActionRow
            label={
              draft.busy
                ? "Applying…"
                : draft.mode === "add"
                  ? draft.preview.systemPrompt &&
                    draft.preview.systemPrompt.before !== draft.preview.systemPrompt.target
                    ? draft.preview.systemPrompt.target === ""
                      ? "Add profiles and clear shared prompt"
                      : "Add profiles and replace shared prompt"
                    : "Add selected profiles"
                  : draft.preview.systemPrompt &&
                      draft.preview.systemPrompt.before !== draft.preview.systemPrompt.target
                    ? draft.preview.systemPrompt.target === ""
                      ? "Replace profiles and clear shared prompt"
                      : "Replace profiles and shared prompt"
                    : "Replace current profiles"
            }
            actionLabel={
              draft.busy
                ? "Applying…"
                : draft.mode === "add"
                  ? "Add"
                  : draft.mode === "restore"
                    ? "Restore"
                    : "Use pack"
            }
            disabled={draft.busy || targetChanged || !selectionsReady}
            onPress={onConfirm}
          />
        </>
      ) : null}
      {draft.error ? (
        <Text accessibilityRole="alert" style={dangerStyle}>
          {draft.error}
        </Text>
      ) : null}
      <Text style={mutedStyle}>
        If another Paseo client changes profiles before you apply, this review may be out of date.
      </Text>
    </ScrollView>
  );
}

export function ApplyReviewSummary({
  preview,
  theme,
  completeTarget,
}: {
  preview: ApplyPreviewState;
  theme: PluginScreenProps["theme"];
  completeTarget: boolean;
}) {
  const style = { color: theme.colors.foreground };
  const warning = { color: theme.colors.statusWarning };
  return (
    <View style={stack}>
      <Text style={style}>Review: {preview.sourceName}</Text>
      {preview.systemPrompt ? (
        <>
          <Text style={warning}>
            Shared by agents on this host; takes effect when sessions start or restart.
          </Text>
          <SharedPromptReview
            before={preview.systemPrompt.before}
            after={preview.systemPrompt.target}
            theme={theme}
          />
        </>
      ) : null}
      <ProfileDiffReview
        before={preview.before}
        after={preview.target}
        theme={theme}
        label="Profile changes"
        completeProfiles={completeTarget ? preview.target : undefined}
      />
      {[...new Set(preview.warnings)].map((item) => (
        <Text key={item} style={warning}>
          {item}
        </Text>
      ))}
    </View>
  );
}

export function ExportReview({
  value,
  path,
  selectedName,
  theme,
  onPathChange,
  onSelectName,
  onDownload,
  onCopy,
  onWrite,
  gistAvailable,
  gistAvailabilityMessage,
  onCreateGist,
  onCopyGistUrl,
}: {
  value: ExportState;
  path: string;
  selectedName: string;
  theme: PluginScreenProps["theme"];
  onPathChange(value: string): void;
  onSelectName(value: string): void;
  onDownload(): void;
  onCopy(file: { name: string; text: string } | undefined): void;
  onWrite(): void;
  gistAvailable: boolean;
  gistAvailabilityMessage: string;
  onCreateGist(): void;
  onCopyGistUrl(): void;
}) {
  const { colors } = theme;
  const textStyle = { color: colors.foreground };
  const mutedStyle = { color: colors.foregroundMuted };
  const dangerStyle = { color: colors.statusDanger };
  const selected = value.files.find(({ name }) => name === selectedName) ?? value.files[0];
  return (
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={stack}>
      <Text style={mutedStyle}>
        {value.files.length} YAML file{value.files.length === 1 ? "" : "s"} produced.
      </Text>
      {value.status ? <Text style={{ color: colors.statusSuccess }}>{value.status}</Text> : null}
      {value.error ? (
        <Text accessibilityRole="alert" style={dangerStyle}>
          {value.error}
        </Text>
      ) : null}
      <Text style={mutedStyle}>
        All selected YAML files, including profile notes and the shared prompt, are sent to GitHub.
        Secret Gists are unlisted, not access-controlled; anyone with the URL can view them.
      </Text>
      <ActionRow
        label="Create a secret GitHub Gist"
        actionLabel={value.busyAction === "gist" ? "Creating…" : "Create gist"}
        hint={!gistAvailable ? gistAvailabilityMessage : undefined}
        disabled={value.busy || !gistAvailable || value.files.length === 0 || !!value.gistUrl}
        onPress={onCreateGist}
      />
      {value.gistUrl ? (
        <View style={stack}>
          <Text style={textStyle}>Gist URL</Text>
          <TextInput
            accessibilityLabel="Created GitHub Gist URL"
            value={value.gistUrl}
            editable={false}
            multiline
            selectTextOnFocus
            style={[
              field,
              textStyle,
              { borderColor: colors.border, backgroundColor: colors.surface1 },
            ]}
          />
          <ActionRow
            label="Copy Gist URL"
            actionLabel={value.busyAction === "gist-url" ? "Copying…" : "Copy"}
            disabled={value.busy}
            onPress={onCopyGistUrl}
          />
        </View>
      ) : null}
      {Platform.OS === "web" ? (
        <ActionRow
          label="Download YAML files to this device"
          actionLabel="Download"
          disabled={value.busy || value.files.length === 0}
          onPress={onDownload}
        />
      ) : null}
      {value.files.length > 1 ? (
        <SettingsSelect
          label="File to copy"
          value={selected?.name ?? ""}
          options={value.files.map(({ name }) => ({ label: name, value: name }))}
          onValueChange={onSelectName}
        />
      ) : null}
      <ActionRow
        label={value.busyAction === "copy" ? "Copying YAML…" : "Copy selected YAML"}
        actionLabel={value.busyAction === "copy" ? "Copying…" : "Copy"}
        disabled={value.busy || !selected}
        onPress={() => onCopy(selected)}
      />
      <TextInput
        accessibilityLabel="Host folder or file path"
        placeholder={
          value.files.length === 1
            ? "Host path to write the YAML file"
            : "Host folder to write the YAML files"
        }
        placeholderTextColor={colors.foregroundMuted}
        value={path}
        onChangeText={onPathChange}
        style={[field, textStyle, { borderColor: colors.border, backgroundColor: colors.surface1 }]}
      />
      <Text style={mutedStyle}>
        {value.files.length === 1
          ? "Saves this file on the selected Paseo host."
          : "Saves one file per pack inside this folder on the selected Paseo host."}
      </Text>
      <ActionRow
        label={value.busyAction === "write" ? "Writing YAML…" : "Write YAML to host path"}
        actionLabel={value.busyAction === "write" ? "Writing…" : "Write"}
        disabled={value.busy || !path.trim()}
        onPress={onWrite}
      />
      {selected ? (
        <View style={stack}>
          <Text style={textStyle}>{selected.name}</Text>
          <TextInput
            accessibilityLabel="Exported YAML"
            value={selected.text}
            editable={false}
            multiline
            selectTextOnFocus
            style={[
              field,
              textStyle,
              { borderColor: colors.border, backgroundColor: colors.surface1 },
              multiline,
            ]}
          />
        </View>
      ) : null}
    </ScrollView>
  );
}
