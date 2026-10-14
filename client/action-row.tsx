import { SettingsAction } from "@getpaseo/plugin/client/ui";

/** Use Paseo's native settings action row for plugin operations. */
export function ActionRow({
  label,
  actionLabel,
  hint,
  disabled,
  onPress,
}: {
  label: string;
  actionLabel: string;
  hint?: string;
  disabled?: boolean;
  onPress(): void;
}) {
  return (
    <SettingsAction
      label={label}
      hint={hint}
      actionLabel={actionLabel}
      disabled={disabled}
      onPress={onPress}
    />
  );
}
