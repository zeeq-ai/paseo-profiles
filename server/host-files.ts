import * as fs from "node:fs/promises";
import path from "node:path";
import { LIMITS } from "../shared/set";
import { atomicWrite, expandPath, regularFile } from "./files";

export async function readHostFile(input: { path: string }) {
  const file = expandPath(input.path);
  await regularFile(file);
  if ((await fs.stat(file)).size > LIMITS.bytes)
    throw new Error("Host file exceeds import size limit");
  return { name: path.basename(file), text: await fs.readFile(file, "utf8") };
}
export async function writeHostFile(input: { path: string; text: string }) {
  if (Buffer.byteLength(input.text, "utf8") > LIMITS.bytes)
    throw new Error("Export exceeds file size limit");
  const file = expandPath(input.path);
  await atomicWrite(file, input.text, true);
  return { path: file };
}
