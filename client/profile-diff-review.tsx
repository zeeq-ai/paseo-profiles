import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { canonicalJson } from "../shared/canonical";
import type { Profile } from "../shared/set";

export type ProfileFieldChange = {
  field: string;
  beforeExists: boolean;
  before: unknown;
  afterExists: boolean;
  after: unknown;
};

export function profileFieldChanges(before: Profile, after: Profile): ProfileFieldChange[] {
  const beforeRecord = before as Record<string, unknown>;
  const afterRecord = after as Record<string, unknown>;
  const fields = [...new Set([...Object.keys(beforeRecord), ...Object.keys(afterRecord)])].sort();
  return fields.flatMap((field) => {
    const beforeExists = Object.hasOwn(beforeRecord, field);
    const afterExists = Object.hasOwn(afterRecord, field);
    const beforeValue = beforeRecord[field];
    const afterValue = afterRecord[field];
    if (
      beforeExists === afterExists &&
      (!beforeExists || canonicalJson(beforeValue) === canonicalJson(afterValue))
    ) {
      return [];
    }
    return [{ field, beforeExists, before: beforeValue, afterExists, after: afterValue }];
  });
}

export function ProfileDiffReview({
  before,
  after,
  theme,
  label = "Profile changes",
  completeProfiles,
}: {
  before: Profile[];
  after: Profile[];
  theme: { colors: { foreground: string; foregroundMuted: string; border: string } };
  label?: string;
  completeProfiles?: Profile[];
}) {
  const [showFullSettings, setShowFullSettings] = useState(false);
  const beforeById = new Map(before.map((profile) => [profile.id, profile]));
  const afterById = new Map(after.map((profile) => [profile.id, profile]));
  const added = after.filter((profile) => !beforeById.has(profile.id));
  const removed = before.filter((profile) => !afterById.has(profile.id));
  const changed = after.flatMap((profile) => {
    const previous = beforeById.get(profile.id);
    if (!previous) return [];
    const fields = profileFieldChanges(previous, profile);
    return fields.length ? [{ before: previous, after: profile, fields }] : [];
  });
  const foreground = { color: theme.colors.foreground };
  const muted = { color: theme.colors.foregroundMuted };
  const section = { gap: 8 };
  const recordStyle = {
    gap: 8,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderColor: theme.colors.border,
  };
  const fieldStyle = { gap: 4, paddingLeft: 10 };

  return (
    <View style={section}>
      <Text style={foreground}>
        {label}: {added.length} added, {changed.length} changed, {removed.length} removed.
      </Text>
      {added.length > 0 || completeProfiles ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: showFullSettings }}
          onPress={() => setShowFullSettings((value) => !value)}
          style={{ paddingVertical: 8 }}
        >
          <Text style={foreground}>
            {showFullSettings ? "Hide full settings" : "Show full settings"}
          </Text>
        </Pressable>
      ) : null}
      {added.length ? (
        <View style={section}>
          <Text style={foreground}>Added profiles</Text>
          {added.map((profile) => (
            <View key={profile.id} style={section}>
              <Text selectable style={muted}>
                {profile.name || profile.id} · {profile.id}
              </Text>
              {showFullSettings ? (
                <Text selectable style={[muted, { fontFamily: "monospace" }]}>
                  {JSON.stringify(profile, null, 2)}
                </Text>
              ) : null}
            </View>
          ))}
        </View>
      ) : null}
      {removed.length ? (
        <View style={section}>
          <Text style={foreground}>Removed profiles</Text>
          {removed.map((profile) => (
            <Text key={profile.id} selectable style={muted}>
              {profile.name || profile.id} · {profile.id}
            </Text>
          ))}
        </View>
      ) : null}
      {changed.length ? (
        <View style={section}>
          <Text style={foreground}>Changed profiles</Text>
          {changed.map(({ before: previous, after: next, fields }) => (
            <View key={next.id} style={recordStyle}>
              <Text selectable style={foreground}>
                {next.name || previous.name || next.id} · {next.id}
              </Text>
              {fields.map((change) => (
                <View key={change.field} style={fieldStyle}>
                  <Text selectable style={foreground}>
                    {change.field}
                  </Text>
                  <Text style={muted}>Before</Text>
                  <Text selectable style={muted}>
                    {formatField(change.before, change.beforeExists)}
                  </Text>
                  <Text style={muted}>After</Text>
                  <Text selectable style={muted}>
                    {formatField(change.after, change.afterExists)}
                  </Text>
                </View>
              ))}
            </View>
          ))}
        </View>
      ) : null}
      {completeProfiles ? (
        <View style={section}>
          <Text style={foreground}>Complete resulting ordered profile list</Text>
          {completeProfiles.map((profile) => (
            <View key={profile.id} style={section}>
              <Text selectable style={muted}>
                {profile.name || profile.id} · {profile.provider} · {profile.id}
              </Text>
              {showFullSettings ? (
                <Text selectable style={[muted, { fontFamily: "monospace" }]}>
                  {JSON.stringify(profile, null, 2)}
                </Text>
              ) : null}
            </View>
          ))}
        </View>
      ) : null}
      {added.length === 0 && changed.length === 0 && removed.length === 0 ? (
        <Text style={muted}>No stored profile fields change.</Text>
      ) : null}
    </View>
  );
}

function formatField(value: unknown, exists: boolean): string {
  if (!exists) return "(not set)";
  if (typeof value === "string") return value.length === 0 ? "(empty string)" : value;
  const formatted = JSON.stringify(value, null, 2);
  return formatted ?? String(value);
}
