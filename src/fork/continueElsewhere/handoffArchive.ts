import { appDataDir } from "@tauri-apps/api/path";
import { createPath, statFiles, writeTextFile } from "../../platform/tauri/fs";

/** Private app data, independent of the checkout and the agent's app-control permissions. */
export async function writeHandoffArchive(text: string): Promise<string> {
  const parent = (await appDataDir()).replace(/[\\/]+$/, "");
  const directory = `${parent}/handoffs`;
  try {
    await createPath(parent, "handoffs", true);
  } catch (error) {
    const [existing] = await statFiles([directory]);
    if (existing?.mtimeMs == null) {
      throw error;
    }
  }
  const path = `${directory}/${crypto.randomUUID()}.md`;
  await writeTextFile(path, text);
  return path;
}
