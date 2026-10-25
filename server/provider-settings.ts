import type { PaseoApi } from "@getpaseo/client";
import type { Profile } from "../shared/set";

type ProviderEntry = Awaited<ReturnType<PaseoApi["providers"]["snapshot"]>>["entries"][number];

/** Adapt a launch bundle to this host without changing the portable library copy. */
export function resolveProfileSettings(
  profiles: Profile[],
  entries: ProviderEntry[],
  current: Profile[],
): { profiles: Profile[]; warnings: string[] } {
  const ready = entries.filter((entry) => entry.enabled && entry.status === "ready");
  const preferred = current.flatMap((profile) => {
    const entry = ready.find((item) => item.provider === profile.provider);
    return entry ? [entry] : [];
  });
  const warnings: string[] = [];
  return {
    profiles: profiles.map((source) => {
      const original = ready.find((entry) => entry.provider === source.provider);
      const provider = original ?? preferred[0] ?? ready[0];
      if (!provider) {
        warnings.push(
          `${source.name}: no ready provider is available. Saved settings are preserved; configure a provider before launching this profile.`,
        );
        return source;
      }
      const profile: Profile = { ...source, provider: provider.provider };
      const providerChanged = source.provider !== provider.provider;
      if (providerChanged) {
        delete profile.modeId;
        delete profile.thinkingOptionId;
        delete profile.featureValues;
        delete profile.providerOptions;
        delete profile.model;
        warnings.push(
          source.provider
            ? `${source.name}: provider ${source.provider} is unavailable. Using ${provider.provider} with its own settings.`
            : `${source.name}: no provider was specified. Using ${provider.provider} from this host.`,
        );
      }
      const models = provider.models?.filter((model) => model.isSelectable !== false);
      const matches = (model: NonNullable<typeof models>[number], id: string | undefined) =>
        !!id && (model.id === id || model.aliases?.includes(id));
      const requested = models?.find((model) => matches(model, profile.model));
      if (models === undefined)
        warnings.push(
          `${source.name}: the model catalog for ${provider.provider} is unavailable. Model availability could not be verified.`,
        );
      // An absent catalog is not evidence that an explicit model is unavailable.
      if (!profile.model || (models !== undefined && !requested)) {
        const local =
          current.find((item) => item.provider === provider.provider && item.id === source.id) ??
          current.find((item) => item.provider === provider.provider && item.model);
        const fallback =
          models?.find((model) => matches(model, local?.model)) ??
          models?.find((model) => model.isDefault) ??
          models?.[0];
        const model = fallback?.id ?? (models === undefined ? local?.model : undefined);
        if (model) profile.model = model;
        else delete profile.model;
        if (source.model || model)
          warnings.push(
            `${source.name}: model ${source.model || "(not set)"} was replaced with ${provider.provider}/${model || "provider default"}.`,
          );
        if (
          profile.thinkingOptionId &&
          !fallback?.thinkingOptions?.some((option) => option.id === profile.thinkingOptionId)
        ) {
          delete profile.thinkingOptionId;
        }
      }
      if (
        profile.modeId &&
        provider.modes &&
        !provider.modes.some((mode) => mode.id === profile.modeId)
      ) {
        delete profile.modeId;
        warnings.push(
          `${source.name}: unavailable mode ${source.modeId} will use the provider default.`,
        );
      }
      return profile;
    }),
    warnings,
  };
}
