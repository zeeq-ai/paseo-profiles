import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { TextInput } from "@getpaseo/plugin/client/react-native";
import { SettingsSelect } from "@getpaseo/plugin/client/ui";
import { Text, View } from "react-native";
import type { ProfileSet } from "../shared/set";
import { ProfileDiffReview } from "./profile-diff-review";
import { SharedPromptReview } from "./shared-prompt-review";

export type GistLinkStorage = "host" | "repository" | "portable";

export function GistAccountSummary({
  hostName,
  accountLogin,
  ownerLogin,
  gistId,
  fileName,
  visibility,
  canPublish,
  theme,
}: {
  hostName: string;
  accountLogin: string | null;
  ownerLogin: string | null;
  gistId: string;
  fileName: string;
  visibility: "public" | "secret" | "unknown";
  canPublish: boolean | null;
  theme: PluginScreenProps["theme"];
}) {
  const colors = theme.colors;
  const muted = { color: colors.foregroundMuted };
  const label = { color: colors.foreground, fontWeight: "600" as const };
  return (
    <View style={{ padding: 16, gap: 8 }}>
      <View style={{ gap: 3 }}>
        <Text style={label}>GitHub account on {hostName}</Text>
        <Text style={muted}>
          {accountLogin ? `@${accountLogin}` : "GitHub account not checked"}
        </Text>
      </View>
      <View style={{ gap: 3 }}>
        <Text style={label}>Gist target</Text>
        <Text style={muted}>
          {ownerLogin
            ? `@${ownerLogin}/${gistId.slice(0, 8)} · ${fileName}`
            : `Gist ${gistId.slice(0, 8)} · ${fileName}`}
        </Text>
      </View>
      <Text style={muted}>
        {visibility === "secret"
          ? "Secret Gist · anyone with its URL can read its history"
          : visibility === "public"
            ? "Public Gist"
            : "Gist visibility not checked"}
        {canPublish === null
          ? " · GitHub ownership not checked"
          : canPublish
            ? " · Publishing available"
            : " · Read-only for this account"}
      </Text>
    </View>
  );
}

export function GistLinkStorageSelector({
  value,
  onChange,
  repositoryPath,
  onRepositoryPathChange,
  sidecarPath,
  defaultRepositoryPath,
  portableVersionHint,
  visibility = "secret",
  disabled = false,
  theme,
}: {
  value: GistLinkStorage;
  onChange(value: GistLinkStorage): void;
  repositoryPath: string;
  onRepositoryPathChange(path: string): void;
  sidecarPath?: string | null;
  defaultRepositoryPath?: string;
  portableVersionHint: string;
  visibility?: "public" | "secret";
  disabled?: boolean;
  theme: PluginScreenProps["theme"];
}) {
  const colors = theme.colors;
  const muted = { color: colors.foregroundMuted };
  const fieldStyle = {
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    minHeight: 44,
    color: colors.foreground,
    borderColor: colors.border,
    backgroundColor: colors.surface1,
  };
  const details: Record<GistLinkStorage, string> = {
    host: "Saved on this Paseo host only. Nothing is added to exports or a Git repository.",
    repository:
      "Saved as a sidecar file in this host's Git working tree. It is not included in pack exports. Teammates receive the link after you commit and push the sidecar.",
    portable: `Saved inside the pack YAML. Plugin versions before ${portableVersionHint} can't read this profile pack. Full-pack exports can include the link.`,
  };

  return (
    <View style={{ gap: 8 }}>
      <SettingsSelect
        label="Where to save this link"
        value={value}
        options={[
          { label: "This Paseo host only", value: "host" },
          { label: "In a Git repository on this host", value: "repository" },
          { label: "Inside this pack file", value: "portable" },
        ]}
        disabled={disabled}
        onValueChange={(next) => onChange(next as GistLinkStorage)}
      />
      {value === "repository" ? (
        <View style={{ paddingHorizontal: 16, gap: 8 }}>
          <TextInput
            accessibilityLabel="Repository folder on this Paseo host"
            placeholder={defaultRepositoryPath || "/absolute/path/to/repository"}
            value={repositoryPath}
            onChangeText={onRepositoryPathChange}
            editable={!disabled}
            autoCapitalize="none"
            autoCorrect={false}
            style={fieldStyle}
          />
          <Text selectable numberOfLines={2} ellipsizeMode="middle" style={muted}>
            {sidecarPath
              ? `Sidecar file: ${sidecarPath}`
              : "Enter an absolute repository folder to preview the sidecar path."}
          </Text>
        </View>
      ) : null}
      <View style={{ paddingHorizontal: 16 }}>
        <Text style={muted}>{details[value]}</Text>
      </View>
      {value !== "host" ? (
        <View style={{ paddingHorizontal: 16 }}>
          {visibility === "secret" ? (
            <Text style={muted}>
              Anyone who gets this pack file or repository sidecar also gets the Gist URL. Secret
              Gists are readable by anyone with the URL, including history.
            </Text>
          ) : (
            <Text style={muted}>
              This link will travel with the selected storage location. The Gist is public.
            </Text>
          )}
        </View>
      ) : null}
    </View>
  );
}

export function GistNamedChanges({
  before,
  after,
  theme,
  label = "Changes",
}: {
  before: ProfileSet;
  after: ProfileSet;
  theme: PluginScreenProps["theme"];
  label?: string;
}) {
  const promptChanged = before.appendSystemPrompt !== after.appendSystemPrompt;
  const nameChanged = before.name !== after.name;
  return (
    <View style={{ gap: 12 }}>
      {nameChanged ? (
        <View style={{ gap: 4 }}>
          <Text style={{ color: theme.colors.foreground, fontWeight: "600" }}>Pack name</Text>
          {before.name ? (
            <Text style={{ color: theme.colors.foregroundMuted }}>Before: {before.name}</Text>
          ) : null}
          <Text style={{ color: theme.colors.foregroundMuted }}>After: {after.name}</Text>
        </View>
      ) : null}
      <ProfileDiffReview
        before={before.profiles}
        after={after.profiles}
        theme={theme}
        label={label}
      />
      <View style={{ gap: 6 }}>
        <Text style={{ color: theme.colors.foreground, fontWeight: "600" }}>
          Shared prompt{promptChanged ? " changed" : " unchanged"}
        </Text>
        <SharedPromptReview
          before={before.appendSystemPrompt}
          after={after.appendSystemPrompt}
          theme={theme}
        />
      </View>
    </View>
  );
}
