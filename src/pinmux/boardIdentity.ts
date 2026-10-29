import * as fs from "fs";
import { loadPinmuxFile } from "./parser";

export interface BoardPinmuxIdentity {
  chipId: string;
  packageId: string;
}

export function parseBoardPinmuxIdentity(source: string): BoardPinmuxIdentity | undefined {
  // Ignore commented examples, so only the active BSP defines determine its identity.
  const active = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\r\n]*/g, "");
  const read = (name: string) => {
    const matches = [...active.matchAll(new RegExp(`^\\s*#define\\s+${name}\\s+"([a-z][a-z0-9-]*)"\\s*$`, "gm"))];
    if (matches.length > 1) throw new Error(`Duplicate ${name} in board_pinmux.c.`);
    return matches[0]?.[1];
  };
  const chipId = read("BSP_PINMUX_CHIP") || read("BSP_PINMUX_DEVICE");
  const packageId = read("BSP_PINMUX_PACKAGE");
  if (!chipId && !packageId && !/BSP_PINMUX_(?:CHIP|DEVICE|PACKAGE)/.test(active)) return undefined;
  if (!chipId || !packageId) throw new Error("Define both BSP_PINMUX_CHIP and BSP_PINMUX_PACKAGE as quoted identifiers in board_pinmux.c.");
  return { chipId, packageId };
}

export async function resolveBoardPinlist(pinmuxFile: string, pinlistFiles: string[]): Promise<string | undefined> {
  const identity = parseBoardPinmuxIdentity(await fs.promises.readFile(pinmuxFile, "utf8"));
  if (!identity) return undefined;
  const matches: string[] = [];
  for (const file of pinlistFiles) {
    const { definition } = await loadPinmuxFile(file);
    if (definition.chip.id === identity.chipId && definition.package.id === identity.packageId) matches.push(file);
  }
  if (matches.length !== 1) throw new Error(`Expected one .impx for ${identity.chipId}/${identity.packageId}, found ${matches.length}. Check BSP Pinmux identifiers and definitions.`);
  return matches[0];
}
