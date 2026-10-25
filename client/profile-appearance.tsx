import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { SettingsSelect } from "@getpaseo/plugin/client/ui";
import { Text, View } from "react-native";
import type { Profile } from "../shared/set";

// Paseo 0.11.2 profile registry. Unknown values remain portable and use host defaults.
const icons: Record<string, string> = {
  code: "Code",
  terminal: "Terminal",
  bug: "Bug",
  wrench: "Wrench",
  hammer: "Hammer",
  flask: "FlaskConical",
  testTube: "TestTube",
  microscope: "Microscope",
  search: "Search",
  eye: "Eye",
  palette: "Palette",
  feather: "Feather",
  pencil: "Pencil",
  fileText: "FileText",
  book: "BookOpen",
  rocket: "Rocket",
  package: "Package",
  boxes: "Boxes",
  server: "Server",
  database: "Database",
  cpu: "Cpu",
  cloud: "Cloud",
  globe: "Globe",
  gitBranch: "GitBranch",
  layers: "Layers",
  compass: "Compass",
  brain: "Brain",
  sparkles: "Sparkles",
  shield: "Shield",
};
const colors = [
  "violet",
  "sky",
  "emerald",
  "orange",
  "pink",
  "indigo",
  "teal",
  "red",
  "amber",
  "blue",
  "none",
];

export function ProfileAppearance({
  profile,
  theme,
}: {
  profile: Profile;
  theme: PluginScreenProps["theme"];
}) {
  return (
    <Text style={{ color: theme.colors.foregroundMuted }}>
      Icon: {profile.icon || "default"}
      {profile.icon && !Object.hasOwn(icons, profile.icon) ? " (preserved; uses default)" : ""} ·
      Color: {profile.color || "default"}
      {profile.color && profile.color !== "none" && !colors.includes(profile.color)
        ? " (preserved; uses default)"
        : ""}
    </Text>
  );
}

export function ProfileAppearanceFields({
  profile,
  disabled,
  onChange,
}: {
  profile: Profile;
  disabled: boolean;
  onChange(change: { icon?: string; color?: string }): void;
}) {
  const options = (values: string[], value: string | undefined) => [
    { label: "Default", value: "" },
    ...values.map((item) => ({ label: item, value: item })),
    ...(value && !values.includes(value)
      ? [{ label: `${value} (unrecognized; preserved)`, value }]
      : []),
  ];
  return (
    <View>
      <SettingsSelect
        label="Icon"
        testID={`profile-${profile.id}-icon`}
        value={profile.icon ?? ""}
        options={options(Object.keys(icons), profile.icon)}
        disabled={disabled}
        onValueChange={(icon) => onChange({ icon })}
      />
      <SettingsSelect
        label="Color"
        testID={`profile-${profile.id}-color`}
        value={profile.color ?? ""}
        options={options(colors, profile.color)}
        disabled={disabled}
        onValueChange={(color) => onChange({ color })}
      />
    </View>
  );
}
