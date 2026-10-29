import * as fs from "fs";
import * as path from "path";

export interface PinmuxBoardTarget {
  id: string;
  directory: string;
  pinmuxFile: string;
  chipDirectory: string;
  source: "project" | "test";
}

export interface PinmuxChipTarget {
  id: string;
  directory: string;
  sourceDirectories: Partial<Record<PinmuxBoardTarget["source"], string>>;
  boards: PinmuxBoardTarget[];
  pinlistFiles: string[];
}

async function readDirectories(directory: string): Promise<fs.Dirent[]> {
  try {
    const entries = await fs.promises.readdir(directory, { withFileTypes: true });
    return entries.filter(entry => entry.isDirectory());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function isFile(filePath: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(filePath)).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function compareIds(left: { id: string }, right: { id: string }): number {
  return left.id.localeCompare(right.id, undefined, { numeric: true, sensitivity: "base" });
}

export async function discoverPinmuxTargets(projectDir: string): Promise<PinmuxChipTarget[]> {
  const bspRoots = [
    { root: path.join(projectDir, "code", "bsp"), source: "project" as const },
    { root: path.join(projectDir, "test", "bsp"), source: "test" as const },
  ];
  const pinlistRoot = path.join(projectDir, "tools", "imde", "pinmux");
  const chipsById = new Map<string, PinmuxChipTarget>();

  for (const { root, source } of bspRoots) {
    const chipDirectories = await readDirectories(root);
    for (const chipEntry of chipDirectories) {
      if (chipEntry.name === "common") continue;

      const chipDirectory = path.join(root, chipEntry.name);
      const boardDirectories = await readDirectories(chipDirectory);
      const chip = chipsById.get(chipEntry.name) || {
        id: chipEntry.name,
        directory: chipDirectory,
        sourceDirectories: {},
        boards: [],
        pinlistFiles: [],
      };
      chip.sourceDirectories[source] = chipDirectory;

      for (const boardEntry of boardDirectories) {
        const boardDirectory = path.join(chipDirectory, boardEntry.name);
        const pinmuxFile = path.join(boardDirectory, "board_pinmux.c");
        if (await isFile(pinmuxFile)) {
          chip.boards.push({ id: boardEntry.name, directory: boardDirectory, pinmuxFile, chipDirectory, source });
        }
      }
      chipsById.set(chipEntry.name, chip);
    }
  }

  for (const chip of chipsById.values()) {
    const pinlistDirectory = path.join(pinlistRoot, chip.id);
    try {
      const entries = await fs.promises.readdir(pinlistDirectory, { withFileTypes: true });
      chip.pinlistFiles = entries
        .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith(".impx"))
        .map(entry => path.join(pinlistDirectory, entry.name))
        .sort((left, right) => path.basename(left).localeCompare(path.basename(right), undefined, { numeric: true, sensitivity: "base" }));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    chip.boards.sort((left, right) => compareIds(left, right) || left.source.localeCompare(right.source));
  }

  return [...chipsById.values()]
    .filter(chip => chip.boards.length > 0 || chip.pinlistFiles.length > 0)
    .sort(compareIds);
}
