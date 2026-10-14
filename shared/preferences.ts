import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const preferences = defineSettings({
  id: "library",
  scope: "host",
  version: 1,
  schema: z.object({ libraryDirectory: z.string().default("") }),
});
