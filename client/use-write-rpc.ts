import type { PluginRpcContract } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { useMutation } from "@tanstack/react-query";
import type { ZodType } from "zod";

/** Writes must never retry automatically after an uncertain response. */
export function useWriteRpc<Input extends ZodType, Output extends ZodType>(
  contract: PluginRpcContract<Input, Output>,
) {
  const invoke = useRpc(contract);
  return useMutation({ mutationFn: invoke, retry: false }).mutateAsync;
}
