import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { LibrarySettings } from "./client/library-settings";
import { ProfileSetsScreen } from "./client/profiles-screen";

function ProfileSetsSidebarItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return (
    <SidebarRow
      icon="Layers3"
      active={currentScreen?.screenId === "main"}
      onPress={() => openScreen({ screenId: "main" })}
    />
  );
}

export default function contribute(client: PluginClientContext) {
  client.addScreen({ id: "main", title: "Agent profile packs", Component: ProfileSetsScreen });
  client.addSidebarHeaderItem({
    id: "profile-sets",
    title: "Agent profile packs",
    Component: ProfileSetsSidebarItem,
  });
  client.addSettingsScreen({
    id: "library-folder",
    title: "Library folder",
    icon: "FolderCog",
    Component: LibrarySettings,
  });
  client.addCommandCenterItem({
    id: "open-profile-sets",
    title: "Manage agent profile packs",
    icon: "Layers3",
    keywords: ["profiles", "packs", "import", "export"],
    context: "global",
    onSelect({ openScreen }) {
      openScreen({ screenId: "main" });
    },
  });
  client.addCommandCenterItem({
    id: "profile-sets-library-folder",
    title: "Profile pack library folder",
    icon: "FolderCog",
    keywords: ["profiles", "packs", "folder", "library"],
    context: "global",
    onSelect({ openSettings }) {
      openSettings("library-folder");
    },
  });
  return () => {};
}
