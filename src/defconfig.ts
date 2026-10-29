import * as vscode from "vscode";
import { ImdeRunner } from "./imdeRunner";

const RECENT_DEFCONFIGS_KEY = "imde.recentDefconfigs";
const MAX_RECENT = 5;

interface DefconfigRecord {
  token: string;
  relativePath?: string;
  sourceRoot?: string;
  rootRelativePath?: string;
  boardFamily?: string;
  microchip?: string;
  board?: string;
}

interface SourceItem extends vscode.QuickPickItem {
  source: string;
  sourceKind: "chip" | "middleware" | "test" | "other";
  records: DefconfigRecord[];
}

interface ChipItem extends vscode.QuickPickItem {
  chip: string;
  records: DefconfigRecord[];
}

interface ConfigGroupItem extends vscode.QuickPickItem {
  records: DefconfigRecord[];
  segments: string[];
}

interface DefconfigItem extends vscode.QuickPickItem {
  commandArgs: string[];
  recentKey: string;
  legacyToken: string;
}

type PickStepResult<T> =
  | { action: "pick"; item: T }
  | { action: "back" }
  | { action: "cancel" };

interface BackPickItem extends vscode.QuickPickItem {
  isBack: true;
}

function showPickStep<T extends vscode.QuickPickItem>(
  items: readonly T[],
  placeHolder: string,
  showBack: boolean,
  searchItems?: (value: string) => readonly T[],
): Promise<PickStepResult<T>> {
  return new Promise((resolve) => {
    const picker = vscode.window.createQuickPick<T | BackPickItem>();
    let settled = false;
    const backItem: BackPickItem = {
      label: "← Back",
      alwaysShow: true,
      isBack: true,
    };
    picker.items = showBack ? [backItem, ...items] : items;
    picker.placeholder = placeHolder;
    picker.matchOnDescription = true;
    picker.matchOnDetail = true;
    picker.onDidChangeValue((value) => {
      if (!searchItems) return;
      const matches = searchItems(value.trim());
      picker.items = showBack ? [backItem, ...matches] : matches;
    });

    const finish = (result: PickStepResult<T>) => {
      if (settled) return;
      settled = true;
      resolve(result);
      picker.hide();
    };

    picker.onDidAccept(() => {
      const selected = picker.selectedItems[0];
      if (!selected) return;
      if ("isBack" in selected) {
        finish({ action: "back" });
      } else {
        finish({ action: "pick", item: selected });
      }
    });
    picker.onDidHide(() => {
      if (!settled) {
        settled = true;
        resolve({ action: "cancel" });
      }
      picker.dispose();
    });
    picker.show();
  });
}

function normalizedRoot(record: DefconfigRecord): string {
  return (record.sourceRoot || "").replace(/\\/g, "/").replace(/^\.\//, "");
}

function sourceIdentity(record: DefconfigRecord): Pick<SourceItem, "source" | "sourceKind"> {
  const root = normalizedRoot(record);
  if (root === "config" && record.boardFamily) {
    return { source: record.boardFamily, sourceKind: "chip" };
  }
  if (root === "test") {
    return { source: "test", sourceKind: "test" };
  }
  if (root === "code/middleware" || root.endsWith("/middleware")) {
    return { source: "middleware", sourceKind: "middleware" };
  }
  return { source: root.split("/").filter(Boolean).pop() || root, sourceKind: "other" };
}

function withoutPrefix(value: string, prefix: string): string {
  const normalized = value.replace(/\\/g, "/");
  const expected = `${prefix}/`;
  return normalized.startsWith(expected) ? normalized.slice(expected.length) : normalized;
}

function selectionArgs(record: DefconfigRecord, source: string): { args: string[]; label: string } {
  const relative = record.rootRelativePath || record.token;
  if (source === "test" && record.microchip) {
    const config = withoutPrefix(relative, record.microchip);
    return { args: ["--reconfigure", "--object", "default", source, record.microchip, config], label: config };
  }
  if (source === "test") {
    return { args: ["--reconfigure", "--object", "default", record.token], label: record.token };
  }

  const config = record.boardFamily && normalizedRoot(record) === "config"
    ? withoutPrefix(relative, record.boardFamily)
    : relative;
  return { args: ["--reconfigure", "--object", "default", source, config], label: config };
}

function makeConfigItems(
  records: DefconfigRecord[],
  source: string,
  recent: string[],
): DefconfigItem[] {
  const recentSet = new Set(recent);
  const items = records.map((record) => {
    const selection = selectionArgs(record, source);
    const recentKey = record.relativePath || record.token;
    const isRecent = recentSet.has(recentKey) || recentSet.has(record.token);
    return {
      label: selection.label,
      commandArgs: selection.args,
      recentKey,
      legacyToken: record.token,
      description: `${isRecent ? "$(history) " : ""}${record.relativePath || ""}`.trim(),
      detail: [
        record.microchip ? `Microchip: ${record.microchip}` : "",
        record.board ? `Board: ${record.board}` : "",
      ].filter(Boolean).join(" · ") || undefined,
    };
  });

  return items.sort((left, right) => {
    const leftRecent = recentSet.has(left.recentKey) || recentSet.has(left.legacyToken);
    const rightRecent = recentSet.has(right.recentKey) || recentSet.has(right.legacyToken);
    if (leftRecent !== rightRecent) return leftRecent ? -1 : 1;
    return left.label.localeCompare(right.label);
  });
}

function pathSegments(record: DefconfigRecord, source: string): string[] {
  let value = (record.rootRelativePath || record.token).replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (source === "test" && record.microchip) value = withoutPrefix(value, record.microchip);
  return value.split("/").filter(Boolean);
}

function recordsAtGroup(records: DefconfigRecord[], source: string, prefix: string[]): { groups: ConfigGroupItem[]; leaves: DefconfigRecord[] } {
  const groups = new Map<string, DefconfigRecord[]>();
  const leaves: DefconfigRecord[] = [];
  for (const record of records) {
    const segments = pathSegments(record, source);
    if (!prefix.every((segment, index) => segments[index] === segment)) continue;
    if (segments.length <= prefix.length + 1) {
      leaves.push(record);
      continue;
    }
    const key = segments[prefix.length];
    const grouped = groups.get(key) || [];
    grouped.push(record);
    groups.set(key, grouped);
  }
  return {
    groups: [...groups.entries()].map(([label, grouped]) => ({
      label,
      records: grouped,
      segments: [...prefix, label],
      description: `${grouped.length} configs`,
      iconPath: new vscode.ThemeIcon("folder"),
    })).sort((left, right) => left.label.localeCompare(right.label)),
    leaves,
  };
}

export async function selectDefconfig(
  runner: ImdeRunner,
  context?: vscode.ExtensionContext,
  after?: () => void,
) {
  const output = await runner.captureJson<{
    defconfigs?: DefconfigRecord[];
  }>("list-defconfigs");
  if (!output?.defconfigs?.length) {
    vscode.window.showWarningMessage("No defconfigs found");
    return;
  }

  const recent: string[] = context?.workspaceState.get<string[]>(RECENT_DEFCONFIGS_KEY) || [];
  const sourceMap = new Map<string, SourceItem>();
  for (const record of output.defconfigs) {
    const identity = sourceIdentity(record);
    if (!identity.source) continue;
    const existing = sourceMap.get(identity.source);
    if (existing) {
      existing.records.push(record);
      existing.description = `${existing.records.length} configs`;
      continue;
    }
    sourceMap.set(identity.source, {
      label: identity.source,
      source: identity.source,
      sourceKind: identity.sourceKind,
      records: [record],
      description: "1 config",
      iconPath: new vscode.ThemeIcon(
        identity.sourceKind === "chip" ? "circuit-board" : identity.sourceKind === "test" ? "beaker" : "library",
      ),
    });
  }

  const sourceOrder: Record<SourceItem["sourceKind"], number> = {
    chip: 0,
    middleware: 1,
    test: 2,
    other: 3,
  };
  const sources = [...sourceMap.values()].sort((left, right) =>
    sourceOrder[left.sourceKind] - sourceOrder[right.sourceKind] || left.label.localeCompare(right.label));
  let pickedSource: SourceItem | undefined;
  let picked: DefconfigItem | undefined;
  const searchableItems = (records: DefconfigRecord[]): DefconfigItem[] => records.flatMap(record => {
    const source = sourceIdentity(record).source;
    return makeConfigItems([record], source, recent).map(item => ({
      ...item,
      label: record.relativePath || `${source}/${record.rootRelativePath || record.token}`,
    }));
  });
  while (!picked) {
    if (!pickedSource) {
      const sourceResult = await showPickStep<SourceItem | DefconfigItem>(
        sources, "Select config source...", false,
        query => query ? searchableItems(output.defconfigs!) : sources,
      );
      if (sourceResult.action !== "pick") return;
      if ("commandArgs" in sourceResult.item) {
        picked = sourceResult.item;
        break;
      }
      pickedSource = sourceResult.item;
    }

    let records = pickedSource.records;
    if (pickedSource.sourceKind === "test") {
      const chipMap = new Map<string, DefconfigRecord[]>();
      for (const record of records) {
        const chip = record.microchip || "Unclassified";
        const grouped = chipMap.get(chip) || [];
        grouped.push(record);
        chipMap.set(chip, grouped);
      }
      const chips: ChipItem[] = [...chipMap.entries()]
        .map(([chip, chipRecords]) => ({
          label: chip,
          chip,
          records: chipRecords,
          description: `${chipRecords.length} configs`,
          iconPath: new vscode.ThemeIcon("circuit-board"),
        }))
        .sort((left, right) => left.label.localeCompare(right.label));
      const chipResult = await showPickStep<ChipItem | DefconfigItem>(
        chips, "Select test chip...", true,
        query => query ? searchableItems(records) : chips,
      );
      if (chipResult.action === "cancel") return;
      if (chipResult.action === "back") {
        pickedSource = undefined;
        continue;
      }
      if ("commandArgs" in chipResult.item) {
        picked = chipResult.item;
        break;
      }
      records = chipResult.item.records;
    }

    let prefix: string[] = [];
    while (!picked) {
      const next = recordsAtGroup(records, pickedSource.source, prefix);
      const configItems = makeConfigItems(next.leaves, pickedSource.source, recent);
      const choices: vscode.QuickPickItem[] = [...next.groups, ...configItems];
      if (choices.length === 0) break;
      const descendantItems = (query: string): DefconfigItem[] => {
        const descendants = records.filter(record => {
          const segments = pathSegments(record, pickedSource!.source);
          const fullPath = segments.join("/");
          return !query || fullPath.toLowerCase().includes(query.toLowerCase());
        });
        return descendants.map(record => {
          const item = makeConfigItems([record], pickedSource!.source, recent)[0];
          return { ...item, label: pathSegments(record, pickedSource!.source).join("/") };
        });
      };
      const configResult = await showPickStep(
        choices,
        `Select ${pickedSource.source} defconfig...`,
        true,
        query => query ? descendantItems(query) : choices,
      );
      if (configResult.action === "cancel") return;
      if (configResult.action === "back") {
        if (prefix.length > 0) {
          prefix = prefix.slice(0, -1);
          continue;
        }
        if (pickedSource.sourceKind !== "test") pickedSource = undefined;
        break;
      }
      const item = configResult.item;
      if ("commandArgs" in item) {
        picked = item as DefconfigItem;
      } else {
        prefix = (item as ConfigGroupItem).segments;
      }
    }
  }

  const result = await runner.runCommand("use-defconfig", picked.commandArgs, {
    progressTitle: `Using ${picked.label}`, streamOutput: true,
  });
  if (result.code === 0 && !result.timedOut) {
    if (context) {
      const updated = [picked.recentKey, ...recent.filter((item) =>
        item !== picked.recentKey && item !== picked.legacyToken)].slice(0, MAX_RECENT);
      await context.workspaceState.update(RECENT_DEFCONFIGS_KEY, updated);
    }
    after?.();
  }
}

export async function saveDefconfig(runner: ImdeRunner) {
  const name = await vscode.window.showInputBox({
    prompt: "Defconfig name (without _defconfig suffix) — saved to config/",
    placeHolder: "myboard -> config/myboard_defconfig",
    validateInput: (v) => {
      if (!v.trim()) return "Name is required";
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(v.trim())) return "Use letters, numbers, underscores, or dashes";
      return undefined;
    },
  });
  if (!name) return;

  await runner.runCommand("save-defconfig", [name.trim()], {
    progressTitle: `Saving ${name.trim()}_defconfig`, streamOutput: true,
  });
}
