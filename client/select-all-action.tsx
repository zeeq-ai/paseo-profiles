import { ActionRow } from "./action-row";

export function SelectAllAction({
  ids,
  selected,
  disabled,
  onChange,
}: {
  ids: string[];
  selected: string[];
  disabled?: boolean;
  onChange(ids: string[]): void;
}) {
  const count = ids.filter((id) => selected.includes(id)).length;
  const allSelected = ids.length > 0 && count === ids.length;
  return (
    <ActionRow
      label={`${count} of ${ids.length} selected`}
      actionLabel={allSelected ? "Clear selection" : "Select all"}
      disabled={disabled || ids.length === 0}
      onPress={() => onChange(allSelected ? [] : ids)}
    />
  );
}
