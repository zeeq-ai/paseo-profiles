import {
  type PluginSurfaceProps,
  type SettingsState,
  useRpc,
  useSettings,
} from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  type SettingsInputHandle,
  SettingsSection,
} from "@getpaseo/plugin/client/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Text, View } from "react-native";
import { preferences } from "../shared/preferences";
import { listLibrary } from "../shared/rpc";

type ReadySettings = Extract<SettingsState<typeof preferences.schema>, { status: "ready" }>;

function FolderSettings({
  settings,
  theme,
}: {
  settings: ReadySettings;
  theme: PluginSurfaceProps["theme"];
}) {
  const list = useRpc(listLibrary);
  const [draft, setDraft] = useState<{
    values: ReadySettings["values"];
    revision: string;
    originalDirectory: string;
  } | null>(null);
  const inputRef = useRef<SettingsInputHandle>(null);
  const folderRequest = useRef(0);
  const [resolvedRoot, setResolvedRoot] = useState("");
  const [folderErrors, setFolderErrors] = useState<string[]>([]);
  const [readError, setReadError] = useState<string | null>(null);
  const [loadingFolder, setLoadingFolder] = useState(false);
  const textStyle = useMemo(() => ({ color: theme.colors.foreground }), [theme]);
  const mutedStyle = useMemo(() => ({ color: theme.colors.foregroundMuted }), [theme]);
  const errorStyle = useMemo(() => ({ color: theme.colors.statusDanger }), [theme]);

  const inspectFolder = useCallback(
    async (directory: string) => {
      const request = ++folderRequest.current;
      setLoadingFolder(true);
      setReadError(null);
      try {
        const result = await list({ libraryRoot: directory });
        if (request !== folderRequest.current) return;
        setResolvedRoot(result.libraryRoot);
        setFolderErrors(result.errors.map(({ name, error }) => `${name}: ${error}`));
      } catch (error) {
        if (request === folderRequest.current) setReadError(errorMessage(error));
      } finally {
        if (request === folderRequest.current) setLoadingFolder(false);
      }
    },
    [list],
  );

  useEffect(() => {
    void inspectFolder(settings.values.libraryDirectory);
  }, [inspectFolder, settings.values.libraryDirectory]);

  const beginEdit = useCallback(() => {
    setDraft({
      values: settings.values,
      revision: settings.revision,
      originalDirectory: settings.values.libraryDirectory,
    });
  }, [settings.revision, settings.values]);

  const updateDraft = useCallback((libraryDirectory: string) => {
    setDraft((current) =>
      current ? { ...current, values: { ...current.values, libraryDirectory } } : current,
    );
  }, []);

  const save = useCallback(async () => {
    if (!draft) return;
    const saved = await settings.save(draft.values, draft.revision);
    if (saved) {
      setDraft(null);
    }
  }, [draft, settings]);

  const discard = useCallback(() => {
    setDraft(null);
    void settings.reload();
  }, [settings]);

  return (
    <View style={{ gap: 16, padding: 16 }}>
      <SettingsSection
        title="Library folder"
        info="This folder lives on the selected Paseo host. It is not a folder on this device."
      >
        <SettingsCard>
          {draft ? (
            <>
              <SettingsInput
                label="Host folder path"
                hint="Leave blank to use Paseo’s default plugin-data/paseo-profiles/sets folder."
                initialValue={draft.values.libraryDirectory}
                onChangeText={updateDraft}
                ref={inputRef}
                placeholder="Default library folder"
                disabled={settings.saving}
                error={settings.saveError}
              />
              <SettingsAction
                label="Save library folder preference"
                actionLabel={settings.saving ? "Saving…" : "Save folder"}
                disabled={
                  settings.saving || draft.values.libraryDirectory === draft.originalDirectory
                }
                onPress={() => void save()}
              />
              <SettingsAction
                label="Use the default library folder"
                actionLabel="Use default"
                disabled={settings.saving || draft.values.libraryDirectory === ""}
                onPress={() => {
                  inputRef.current?.replaceText("");
                  updateDraft("");
                }}
              />
              <SettingsAction
                label="Discard library folder changes"
                actionLabel="Discard"
                disabled={settings.saving}
                onPress={discard}
              />
            </>
          ) : (
            <>
              <View style={{ padding: 16, gap: 8 }}>
                <Text style={mutedStyle}>
                  {settings.values.libraryDirectory || "Using Paseo’s default library folder"}
                </Text>
              </View>
              <SettingsAction
                label="Edit library folder preference"
                actionLabel="Edit folder"
                onPress={beginEdit}
              />
            </>
          )}
          <SettingsAction
            label="Check folder access"
            actionLabel={loadingFolder ? "Checking…" : "Check folder"}
            disabled={loadingFolder}
            onPress={() => void inspectFolder(settings.values.libraryDirectory)}
          />
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="Resolved host folder">
        <SettingsCard>
          <View style={{ padding: 16, gap: 8 }}>
            <Text selectable style={textStyle}>
              {resolvedRoot || (loadingFolder ? "Checking folder…" : "Not resolved")}
            </Text>
            <Text style={mutedStyle}>
              The resolved path is provided by the selected host. Changing this preference opens
              another library; it does not move files or change current profiles.
            </Text>
            {readError ? (
              <Text accessibilityRole="alert" style={errorStyle}>
                {readError}
              </Text>
            ) : null}
            {folderErrors.map((error) => (
              <Text key={error} accessibilityRole="alert" style={errorStyle}>
                {error}
              </Text>
            ))}
          </View>
        </SettingsCard>
      </SettingsSection>
    </View>
  );
}

export function LibrarySettings(props: PluginSurfaceProps) {
  const settings = useSettings(preferences);
  const style = useMemo(() => ({ color: props.theme.colors.foreground }), [props.theme]);
  if (settings.status === "loading") return <Text style={style}>Loading library settings…</Text>;
  if (settings.status !== "ready") {
    return (
      <View style={{ padding: 16, gap: 12 }}>
        <SettingsSection title="Library folder">
          <Text accessibilityRole="alert" style={style}>
            {settings.error}
          </Text>
          <SettingsAction
            label="Reload library settings"
            actionLabel="Reload"
            onPress={() => void settings.reload()}
          />
          {settings.status === "invalid" ? (
            <SettingsAction
              label="Restore default settings"
              actionLabel="Reset"
              onPress={() => void settings.reset()}
            />
          ) : null}
        </SettingsSection>
      </View>
    );
  }
  return <FolderSettings settings={settings} theme={props.theme} />;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
