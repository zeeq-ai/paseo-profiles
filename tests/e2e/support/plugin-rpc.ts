import type { PluginRpcContract } from "@getpaseo/plugin";
import type { z } from "zod";
import type { IsolatedDaemon } from "./isolated-daemon";
import { pluginId } from "./isolated-daemon";

export async function callPluginRpc<Input extends z.ZodType, Output extends z.ZodType>(
  daemon: IsolatedDaemon,
  contract: PluginRpcContract<Input, Output>,
  input: z.input<Input>,
): Promise<z.output<Output>> {
  const parsedInput = await contract.input.parseAsync(input);
  const result = await daemon.client.invokePluginRpc(pluginId(), contract.name, parsedInput);
  return contract.output.parseAsync(result);
}
