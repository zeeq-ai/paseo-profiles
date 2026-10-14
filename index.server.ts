import type { PaseoApi } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { readHostFile, writeHostFile } from "./server/host-files";
import { ProfileService } from "./server/profile-service";
import { preferences } from "./shared/preferences";
import * as rpc from "./shared/rpc";

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(preferences);
  let service: ProfileService | undefined;
  const getService = (paseo: PaseoApi) => {
    service ??= new ProfileService({
      paseo,
      getDirectory: async () => {
        const state = await settings.read();
        if (state.status !== "ready")
          throw new Error(`Library preference is invalid: ${state.error}`);
        return state.values.libraryDirectory;
      },
    });
    return service;
  };
  server.handle(rpc.listLibrary, (input, { paseo }) => getService(paseo).listLibrary(input));
  server.handle(rpc.readSet, (input, { paseo }) => getService(paseo).readSet(input));
  server.handle(rpc.saveSet, (input, { paseo }) => getService(paseo).saveSet(input));
  server.handle(rpc.duplicateSet, (input, { paseo }) => getService(paseo).duplicateSet(input));
  server.handle(rpc.deleteSet, (input, { paseo }) => getService(paseo).deleteSet(input));
  server.handle(rpc.currentProfiles, (input, { paseo }) =>
    getService(paseo).currentProfiles(input),
  );
  server.handle(rpc.captureCurrent, (input, { paseo }) => getService(paseo).captureCurrent(input));
  server.handle(rpc.exportProfiles, (input, { paseo }) => getService(paseo).exportProfiles(input));
  server.handle(rpc.importPreview, (input, { paseo }) => getService(paseo).importPreview(input));
  server.handle(rpc.importCommit, (input, { paseo }) => getService(paseo).importCommit(input));
  server.handle(rpc.applyPreview, (input, { paseo }) => getService(paseo).applyPreview(input));
  server.handle(rpc.applyCommit, (input, { paseo }) => getService(paseo).applyCommit(input));
  server.handle(rpc.historyList, (input, { paseo }) => getService(paseo).historyList(input));
  server.handle(rpc.restoreHistory, (input, { paseo }) => getService(paseo).restoreHistory(input));
  server.handle(rpc.recoveryList, (input, { paseo }) => getService(paseo).recoveryList(input));
  server.handle(rpc.readHostFile, readHostFile);
  server.handle(rpc.writeHostFile, writeHostFile);
  return () => {};
}
