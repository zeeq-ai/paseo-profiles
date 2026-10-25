import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { Text, View } from "react-native";

export function SharedPromptReview({
  before,
  after,
  theme,
}: {
  before?: string;
  after?: string;
  theme: PluginScreenProps["theme"];
}) {
  if (before === undefined && after === undefined) return null;
  const muted = { color: theme.colors.foregroundMuted };
  return (
    <View style={{ gap: 6 }}>
      <Text style={{ color: theme.colors.foreground, fontWeight: "600" }}>
        Shared system prompt{before === after ? " (unchanged)" : ""}
      </Text>
      {before !== undefined && before !== after ? (
        <>
          <Text style={muted}>Before</Text>
          <Text selectable style={muted}>
            {before || "(empty)"}
          </Text>
        </>
      ) : null}
      <Text style={muted}>{before !== undefined && before !== after ? "After" : "Pack value"}</Text>
      <Text selectable style={muted}>
        {after === undefined ? "(not included)" : after || "(empty)"}
      </Text>
    </View>
  );
}
