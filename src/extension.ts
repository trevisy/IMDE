import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { ImdeCommandResult, ImdeRunner } from "./imdeRunner";
import { DoctorTreeProvider } from "./doctorTree";
import { ArtifactsTreeProvider, ArtifactTreeItem } from "./artifactsTree";
import { BuildTreeProvider } from "./buildTree";
import { FileWatcher } from "./menuconfig/fileWatcher";
import { Logger } from "./logger/logger";
import { ImdeDiagnostics } from "./diagnostics";
import type { MapParseResult } from "./mapview/parser";
import { selectDefconfig, saveDefconfig } from "./defconfig";
import { syncIntelliSense } from "./intelliSense";

function extensionKconfig(projectDir: string): string | undefined {
  try {
    const entries = fs.readdirSync(projectDir, { withFileTypes: true });
    const kconfigs: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const manifest = path.join(projectDir, entry.name, "imde-extension.json");
      if (fs.existsSync(manifest)) {
        const data = JSON.parse(fs.readFileSync(manifest, "utf8")) as { kconfig?: unknown };
        if (typeof data.kconfig !== "string" || !data.kconfig.trim()) continue;
        const kconfig = path.resolve(projectDir, data.kconfig);
        if (fs.existsSync(kconfig)) kconfigs.push(kconfig);
      }
    }
    if (kconfigs.length === 0) return undefined;
    const generated = path.join(projectDir, ".imde", "kconfig", "extensions.Kconfig");
    const kconfigPath = (value: string): string => value.replace(/\\/g, "/");
    const content = [
      'mainmenu "SDK Configuration"',
      `source "${kconfigPath(path.join(projectDir, "Kconfig"))}"`,
      ...kconfigs.map(kconfig => `source "${kconfigPath(kconfig)}"`),
      "",
    ].join("\n");
    fs.mkdirSync(path.dirname(generated), { recursive: true });
    if (!fs.existsSync(generated) || fs.readFileSync(generated, "utf8") !== content) {
      fs.writeFileSync(generated, content, "utf8");
    }
    return generated;
  } catch { /* fall back to the base Kconfig */ }
  return undefined;
}
// eslint-disable-next-line @typescript-eslint/no-var-requires
const PACKAGE_JSON = require("../package.json") as { version?: string };
// Cache for parsed .map files: path -> { mtime, data }.  Bounded to prevent unbounded growth.
const mapCache = new Map<string, { mtime: number; data: MapParseResult }>();
const MAP_CACHE_MAX = 8;

async function getCachedMapData(filePath: string): Promise<MapParseResult> {
  const stat = await fs.promises.stat(filePath);
  const cached = mapCache.get(filePath);
  if (cached && cached.mtime === stat.mtimeMs) {
    return cached.data;
  }
  const { parseMapFile } = await import("./mapview/parser");
  const content = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
  const text = Buffer.from(content).toString("utf-8");
  const data = parseMapFile(text);
  if (mapCache.size >= MAP_CACHE_MAX) {
    const first = mapCache.keys().next().value as string;
    mapCache.delete(first);
  }
  mapCache.set(filePath, { mtime: stat.mtimeMs, data });
  return data;
}

export function activate(context: vscode.ExtensionContext) {
  Logger.info("IMDE extension is now active");

  const runner = new ImdeRunner();
  context.subscriptions.push(runner);

  if (!runner.isValidImdeProject) {
    Logger.info("IMDE: imde.json not found within 10 levels — extension idle.");
    // Register only a minimal set of commands that show guidance
    context.subscriptions.push(
      vscode.commands.registerCommand("imde.doctor", () =>
        vscode.window.showWarningMessage("IMDE: not an IMDE project. Open a workspace that contains imde.json.")
      ),
      vscode.commands.registerCommand("imde.build", () =>
        vscode.window.showWarningMessage("IMDE: not an IMDE project. Open a workspace that contains imde.json.")
      ),
      vscode.commands.registerCommand("imde.guiConfig", () =>
        vscode.window.showWarningMessage("IMDE: not an IMDE project. Open a workspace that contains imde.json.")
      ),
    );
    return;
  }

  ImdeRunner.warmupEnv();

  // ---- Workspace folder change handling ----
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      runner.resetProjectCheck();
    }),
  );

  // ---- IntelliSense (auto-setup include paths / defines from CMake) ----
  const intelliSenseSync = (): string | null => {
    const proj = runner.getProjectDir();
    if (!proj) return null;
    const msg = syncIntelliSense(proj);
    if (msg) { Logger.info(msg); }
    return msg;
  };
  // Run once on activation if compile_commands.json already exists
  const intelliSenseTimer = setTimeout(intelliSenseSync, 3000);
  context.subscriptions.push({ dispose: () => clearTimeout(intelliSenseTimer) });

  // ---- Diagnostics (Problems panel integration) ----
  const diagnostics = new ImdeDiagnostics(runner.getProjectDir());
  context.subscriptions.push(diagnostics);

  // ---- File watcher for config changes ----
  const fileWatcher = new FileWatcher(context);
  fileWatcher.initialize();

  // ---- Tree views ----
  const doctorTree = new DoctorTreeProvider(runner);
  const buildTree = new BuildTreeProvider(runner);
  const artifactsTree = new ArtifactsTreeProvider(runner);

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("imde.doctorView", doctorTree),
    vscode.window.registerTreeDataProvider("imde.buildView", buildTree),
    vscode.window.registerTreeDataProvider("imde.artifactsView", artifactsTree),
  );

  let refreshMapStatus: (() => void) | undefined;

  const refreshAll = () => {
    runner.invalidateJsonCache();
    doctorTree.refresh(true);
    buildTree.refresh();
    artifactsTree.refresh();
    refreshMapStatus?.();
  };

  const refreshProjectState = (options?: { doctor?: boolean; intelliSense?: boolean; map?: boolean }) => {
    runner.invalidateJsonCache();
    if (options?.doctor) {
      doctorTree.refresh(true);
    }
    buildTree.refresh();
    artifactsTree.refresh();
    if (options?.intelliSense) {
      intelliSenseSync();
    }
    if (options?.map) {
      refreshMapStatus?.();
    }
  };

  const runAction = async (
    command: string,
    args: string[],
    title: string,
    after?: () => void,
  ) => {
    diagnostics.clear();
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title, cancellable: false },
      () => runner.runCommand(command, args, { streamOutput: true }),
    );
    if (result.code !== 0 || result.timedOut) {
      const count = diagnostics.report(result.stderr + "\n" + result.stdout);
      if (count > 0) {
        const action = await vscode.window.showErrorMessage(
          `IMDE ${command} failed with ${count} issue${count > 1 ? "s" : ""}.`,
          "Show Problems", "Show Terminal"
        );
        if (action === "Show Problems") {
          vscode.commands.executeCommand("workbench.actions.view.problems");
        } else if (action === "Show Terminal") {
          runner.showCommandTerminal();
        }
        return; // Don't call reportResult again
      }
    }
    await reportResult(runner, command, result);
    if (result.code === 0 && !result.timedOut) {
      after?.();
    }
  };

  const runManagedAction = async (
    command: string,
    args: string[],
    title: string,
    options?: {
      successMessage?: string;
      refreshDoctor?: boolean;
      syncIntelliSense?: boolean;
      refreshMap?: boolean;
      timeoutMs?: number;
    },
  ): Promise<boolean> => {
    diagnostics.clear();
    runner.invalidateJsonCache();
    const result = await runner.runCommand(command, args, {
      progressTitle: title,
      progressDetail: title,
      streamOutput: true,
      timeoutMs: options?.timeoutMs,
    });

    if (result.code !== 0 || result.timedOut) {
      const issueCount = diagnostics.report(result.stderr + "\n" + result.stdout);
      const reason = result.timedOut
        ? "timed out"
        : `failed with exit code ${result.code ?? "unknown"}`;
      vscode.window.setStatusBarMessage(`$(error) IMDE ${command} ${reason}`, 5000);
      if (vscode.workspace.getConfiguration("imde").get<boolean>("showOutputOnError") ?? true) {
        runner.showCommandTerminal();
      }
      const action = issueCount > 0
        ? await vscode.window.showErrorMessage(
          `IMDE ${command} ${reason} with ${issueCount} issue${issueCount > 1 ? "s" : ""}.`,
          "Show Problems",
          "Show Terminal",
        )
        : await vscode.window.showErrorMessage(
          `IMDE ${command} ${reason}.`,
          "Show Terminal",
        );
      if (action === "Show Problems") {
        vscode.commands.executeCommand("workbench.actions.view.problems");
      } else if (action === "Show Terminal") {
        runner.showCommandTerminal();
      }
      refreshProjectState({
        doctor: options?.refreshDoctor,
        intelliSense: options?.syncIntelliSense,
        map: options?.refreshMap,
      });
      return false;
    }

    refreshProjectState({
      doctor: options?.refreshDoctor,
      intelliSense: options?.syncIntelliSense,
      map: options?.refreshMap,
    });
    if (options?.successMessage) {
      vscode.window.setStatusBarMessage(`$(check) ${options.successMessage}`, 3000);
    }
    return true;
  };

  // ---- Commands ----
  context.subscriptions.push(
    vscode.commands.registerCommand("imde.openEnv", () => {
      runner.openEnvOrRunDoctor(true);
      pollRefresh(() => doctorTree.refresh(true), 2000, 2);
    }),
    vscode.commands.registerCommand("imde.doctor", () => {
      runner.runTerminal("doctor", [], { show: true });
      pollRefresh(() => doctorTree.refresh(true), 2000, 2);
    }),
    vscode.commands.registerCommand("imde.build", () =>
      runManagedAction("build", [], "IMDE Build", {
        successMessage: "Build completed",
        refreshMap: true,
        syncIntelliSense: true,
      })
    ),
    vscode.commands.registerCommand("imde.configure", () =>
      runManagedAction("configure", [], "IMDE Configure", {
        successMessage: "Configure completed",
        syncIntelliSense: true,
        refreshMap: true,
      })
    ),
    vscode.commands.registerCommand("imde.menuconfig", async () => {
      const projDir = runner.getProjectDir();
      const cmakeCache = path.join(projDir, "build", "CMakeCache.txt");
      if (!fs.existsSync(cmakeCache)) {
        const configured = await runManagedAction("configure", [], "IMDE Configure", {
          successMessage: "Configure completed",
          syncIntelliSense: true,
          refreshMap: true,
        });
        if (!configured) {
          return;
        }
      }
      runner.runTerminal("menuconfig", ["--configure-if-needed"], { show: true });
      pollRefresh(() => { buildTree.refresh(); artifactsTree.refresh(); }, 3000, 3);
    }),
    vscode.commands.registerCommand("imde.fullCleanBuild", async () => {
      const cleaned = await runManagedAction("fullclean", ["--yes"], "IMDE Full Clean", {
        successMessage: "Full clean completed",
        refreshMap: true,
      });
      if (!cleaned) {
        return;
      }
      await runManagedAction("build", [], "IMDE Build", {
        successMessage: "Rebuild completed",
        syncIntelliSense: true,
        refreshMap: true,
      });
    }),
    vscode.commands.registerCommand("imde.clean", () =>
      runManagedAction("clean", [], "IMDE Clean", {
        successMessage: "Clean completed",
        refreshMap: true,
      })
    ),
    vscode.commands.registerCommand("imde.fullclean", async () => {
      const ans = await vscode.window.showWarningMessage(
        "Delete the entire IMDE build directory? This cannot be undone.",
        { modal: true },
        "Delete"
      );
      if (ans === "Delete") {
        await runManagedAction("fullclean", ["--yes"], "IMDE Full Clean", {
          successMessage: "Full clean completed",
          refreshMap: true,
        });
      }
    }),
    vscode.commands.registerCommand("imde.status", async () =>
      runAction("status", [], "Reading IMDE status", buildTree.refresh.bind(buildTree))
    ),
    vscode.commands.registerCommand("imde.artifacts", async () =>
      runAction("artifacts", [], "Reading IMDE artifacts", artifactsTree.refresh.bind(artifactsTree))
    ),
    vscode.commands.registerCommand("imde.setupToolchain", async () =>
      runAction("setup-toolchain", [], "Setting up IMDE toolchain", refreshAll)
    ),
    vscode.commands.registerCommand("imde.selectDefconfig", () =>
      selectDefconfig(runner, context, () => {
        refreshProjectState({ intelliSense: true, map: true });
      })
    ),
    vscode.commands.registerCommand("imde.saveDefconfig", async () => {
      await saveDefconfig(runner);
      refreshProjectState({ map: true });
    }),

    vscode.commands.registerCommand("imde.copyPath", async (itemOrPath: ArtifactTreeItem | string) => {
      const filePath = typeof itemOrPath === "string" ? itemOrPath : itemOrPath.artifactPath;
      await vscode.env.clipboard.writeText(filePath);
      vscode.window.showInformationMessage("Path copied");
    }),
    vscode.commands.registerCommand("imde.revealFile", async (itemOrPath: ArtifactTreeItem | string) => {
      const filePath = typeof itemOrPath === "string" ? itemOrPath : itemOrPath.artifactPath;
      await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(filePath));
    }),
    vscode.commands.registerCommand("imde.refresh", refreshAll),

    // Used by Map View webview to open source files from tooltip links
    vscode.commands.registerCommand("imde.openFile", async (args: string | [string, string]) => {
      // Accept single path or [fullPath, relativePath] tuple
      const fullPath = Array.isArray(args) ? args[0] : args;
      const relPath = Array.isArray(args) ? args[1] : "";
      const uri = vscode.Uri.file(fullPath);
      if (fs.existsSync(fullPath)) {
        await vscode.commands.executeCommand("vscode.open", uri);
        return;
      }
      // Fallback: fuzzy search in workspace for the relative source file
      if (relPath) {
        const results = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Window, title: "Searching source file…" },
          () => vscode.workspace.findFiles("**/" + relPath.replace(/\\/g, "/"), null, 1)
        );
        if (results.length > 0) {
          await vscode.commands.executeCommand("vscode.open", results[0]);
          return;
        }
      }
      vscode.window.showWarningMessage("Source file not found: " + (relPath || fullPath));
    }),

    // ---- Pinmux ----
    vscode.commands.registerCommand("imde.pinmux", async () => {
      const projectDir = runner.getProjectDir();
      try {
        const [{ discoverPinmuxTargets }, { loadPinmuxFile }, { loadBoardPinmuxFile }, { generateBoardPinmuxSource, generateBoardPinsHeader }, { createPinmuxBoard, deletePinmuxBoard, validateBoardId }, { PinmuxPanel }] = await Promise.all([
          import("./pinmux/discovery"),
          import("./pinmux/parser"),
          import("./pinmux/boardParser"),
          import("./pinmux/boardGenerator"),
          import("./pinmux/boardWorkspace"),
          import("./pinmux/panel"),
        ]);
        const definitionCache = new Map<string, Awaited<ReturnType<typeof loadPinmuxFile>>>();
        const loadDefinition = async (filePath: string) => {
          const cached = definitionCache.get(filePath);
          if (cached) return cached;
          const loaded = await loadPinmuxFile(filePath);
          definitionCache.set(filePath, loaded);
          return loaded;
        };
        const chips = await discoverPinmuxTargets(projectDir);
        if (chips.length === 0) {
          vscode.window.showWarningMessage("IMDE: no BSP chips with board_pinmux.c were found.");
          return;
        }
        const chipItems = await Promise.all(chips.map(async chip => {
          const packages = await Promise.all(chip.pinlistFiles.map(async file => {
            try {
              const { definition } = await loadDefinition(file);
              return `${definition.chip.name} · ${definition.package.name}`;
            } catch {
              return path.basename(file, ".impx");
            }
          }));
          return {
            label: chip.id,
            description: packages.length ? packages.join("  |  ") : `${chip.boards.length} board${chip.boards.length === 1 ? "" : "s"}`,
            detail: `${chip.pinlistFiles.length} chip/package definition${chip.pinlistFiles.length === 1 ? "" : "s"}`,
            chip,
          };
        }));
        while (true) {
        const chipItem = await vscode.window.showQuickPick(
          chipItems,
          { placeHolder: "Select a chip" },
        );
        if (!chipItem) return;
        const sources = (["project", "test"] as const).filter(source =>
          chipItem.chip.boards.some(board => board.source === source) || chipItem.chip.sourceDirectories[source]);
        while (true) {
        const sourceItem = await vscode.window.showQuickPick(
          [{ label: "← Back", description: "Return to chip selection", alwaysShow: true, isBack: true as const }, ...sources.map(source => ({
            label: source,
            description: `${chipItem.chip.boards.filter(board => board.source === source).length} board${chipItem.chip.boards.filter(board => board.source === source).length === 1 ? "" : "s"}`,
            source,
          }))],
          { placeHolder: `Select ${chipItem.chip.id} source` },
        );
        if (!sourceItem) return;
        if ("isBack" in sourceItem) break;
        const sourceBoards = chipItem.chip.boards.filter(board => board.source === sourceItem.source);
        const { parseBoardPinmuxIdentity } = await import("./pinmux/boardIdentity");
        const boardItems = await Promise.all(sourceBoards.map(async board => {
          let detail: string;
          try {
            const identity = parseBoardPinmuxIdentity(await fs.promises.readFile(board.pinmuxFile, "utf8"));
            detail = identity
              ? `Chip: ${identity.chipId} · Package: ${identity.packageId}`
              : "Chip / Package: not specified";
          } catch (error) {
            detail = `Chip / Package: ${error instanceof Error ? error.message : String(error)}`;
          }
          return {
            label: board.id,
            description: path.relative(projectDir, board.pinmuxFile),
            detail,
            board,
            action: "open" as const,
          };
        }));
        const boardChoices = [
          { label: "← Back", description: "Return to source selection", alwaysShow: true, isBack: true as const },
          ...boardItems,
          { label: "$(add) Create blank BSP...", description: `Create under ${sourceItem.source}/bsp`, action: "create" as const },
          ...(sourceBoards.length > 0
            ? [{ label: "$(trash) Delete BSP...", description: "Remove a board and its CMake/Kconfig registration", action: "delete" as const }]
            : []),
        ];
        const boardItem = await vscode.window.showQuickPick(boardChoices, { placeHolder: `Select a ${chipItem.chip.id} board` });
        if (!boardItem) return;
        if ("isBack" in boardItem) continue;
        if (boardItem.action === "delete") {
          const deleteItem = await vscode.window.showQuickPick(
            sourceBoards.map(board => ({
              label: board.id,
              description: `${board.source} · ${path.relative(projectDir, board.directory)}`,
              board,
            })),
            { placeHolder: `Select a ${chipItem.chip.id} BSP to delete` },
          );
          if (!deleteItem) return;
          if (PinmuxPanel.isShowingBoard(chipItem.chip.id, deleteItem.board.id)) {
            vscode.window.showWarningMessage(`Close the ${chipItem.chip.id}/${deleteItem.board.id} Pinmux panel before deleting its BSP.`);
            return;
          }
          const boardDirectory = path.resolve(deleteItem.board.directory);
          const dirtyDocument = vscode.workspace.textDocuments.find(document => {
            if (!document.isDirty || document.uri.scheme !== "file") return false;
            const relative = path.relative(boardDirectory, path.resolve(document.uri.fsPath));
            return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
          });
          if (dirtyDocument) {
            vscode.window.showWarningMessage(`Save or close ${path.basename(dirtyDocument.uri.fsPath)} before deleting ${deleteItem.board.id}.`);
            return;
          }
          const confirmed = await vscode.window.showWarningMessage(
            `Delete BSP ${chipItem.chip.id}/${deleteItem.board.id}?`,
            {
              modal: true,
              detail: `IMDE will permanently remove ${path.relative(projectDir, boardDirectory)} and update the chip CMakeLists.txt and Kconfig registrations.`,
            },
            "Delete BSP",
          );
          if (confirmed !== "Delete BSP") return;
          const deleted = await deletePinmuxBoard({
            boardId: deleteItem.board.id,
            chipId: chipItem.chip.id,
            chipDirectory: deleteItem.board.chipDirectory,
          });
          vscode.window.showInformationMessage(`IMDE: deleted ${chipItem.chip.id}/${deleted.boardId} and updated board integration.`);
          refreshProjectState({ map: true });
          return;
        }
        if (chipItem.chip.pinlistFiles.length === 0) {
          throw new Error(`No .impx pinlist found for ${chipItem.chip.id}.`);
        }
        let pinlistFile = chipItem.chip.pinlistFiles[0];
        const { resolveBoardPinlist } = await import("./pinmux/boardIdentity");
        const boardPinlist = boardItem.action === "open"
          ? await resolveBoardPinlist(boardItem.board.pinmuxFile, chipItem.chip.pinlistFiles)
          : undefined;
        if (boardPinlist) pinlistFile = boardPinlist;
        if (!boardPinlist && chipItem.chip.pinlistFiles.length > 1) {
          const packageItems = await Promise.all(chipItem.chip.pinlistFiles.map(async filePath => {
            try {
              const { definition } = await loadDefinition(filePath);
              return {
                label: definition.package.name,
                description: `${definition.chip.name} · ${definition.package.id} · ${definition.package.pinCount} pins · ${path.relative(projectDir, filePath)}`,
                filePath,
              };
            } catch {
              return { label: path.basename(filePath), description: path.relative(projectDir, filePath), filePath };
            }
          }));
          const pinlistItem = await vscode.window.showQuickPick(
            packageItems,
            { placeHolder: `Select a ${chipItem.chip.id} package` },
          );
          if (!pinlistItem) return;
          pinlistFile = pinlistItem.filePath;
        }
        const { definition, filePath } = await loadDefinition(pinlistFile);
        if (boardItem.action === "create") {
          const boardId = await vscode.window.showInputBox({
            prompt: `Create a blank ${chipItem.chip.id} BSP`,
            placeHolder: "pd_lock",
            validateInput: value => validateBoardId(value.trim()),
          });
          if (!boardId) return;
          const normalizedBoardId = boardId.trim();
          const pinmuxSource = generateBoardPinmuxSource(definition, chipItem.chip.id, normalizedBoardId, [], {
            mode: "persisted",
            allowEmpty: true,
          });
          const boardPinsSource = generateBoardPinsHeader(chipItem.chip.id, normalizedBoardId, []);
          const confirmed = await vscode.window.showWarningMessage(
            `Create blank BSP ${chipItem.chip.id}/${normalizedBoardId}?`,
            {
              modal: true,
              detail: "IMDE will create an empty board_pinmux.c and board_pins.h, plus the board CMake/Kconfig files. Existing boards are not copied.",
            },
            "Create Board",
          );
          if (confirmed !== "Create Board") return;
          const created = await createPinmuxBoard({
            boardId: normalizedBoardId,
            chipId: chipItem.chip.id,
            chipDirectory: chipItem.chip.sourceDirectories[sourceItem.source] || chipItem.chip.directory,
            pinmuxSource,
            boardPinsSource,
          });
          const boardPinmux = await loadBoardPinmuxFile(created.pinmuxFile, definition);
          PinmuxPanel.createOrShow(context, definition, filePath, chipItem.chip.id, created.boardId, boardPinmux);
          return;
        }
        const boardPinmux = await loadBoardPinmuxFile(boardItem.board.pinmuxFile, definition);
        PinmuxPanel.createOrShow(context, definition, filePath, chipItem.chip.id, boardItem.board.id, boardPinmux);
        return;
        }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`IMDE: Pinmux operation failed. ${message}`);
      }
    }),

    // ---- Map View ----
    vscode.commands.registerCommand("imde.viewMap", async (item?: ArtifactTreeItem) => {
      let filePath: string | undefined;
      if (typeof item === "string") {
        filePath = item;
      } else if (item?.artifactPath) {
        filePath = item.artifactPath;
      } else {
        // Find .map artifact automatically
        const data = await runner.captureJson<{ artifacts?: Record<string, { path: string; exists: boolean }> }>("artifacts");
        if (data?.artifacts) {
          const maps = Object.entries(data.artifacts)
            .filter(([k, v]) => k.endsWith(".map") && v.exists)
            .map(([k, v]) => ({ label: k, path: v.path }));
          if (maps.length === 1) {
            filePath = maps[0].path;
          } else if (maps.length > 1) {
            const picked = await vscode.window.showQuickPick(maps, { placeHolder: "Select a .map file to view" });
            filePath = picked?.path;
          }
        }
        if (!filePath) {
          vscode.window.showWarningMessage("No .map artifact found. Build first?");
          return;
        }
      }
      try {
        const mapData = await getCachedMapData(filePath);
        const { MapViewPanel } = await import("./mapview/panel");
        MapViewPanel.createOrShow(filePath, mapData, runner.getProjectDir());
      } catch (err: any) {
        vscode.window.showErrorMessage(`Failed to parse map file: ${err.message}`);
      }
    }),

    // ---- GUI Config (Visual Kconfig Editor) ----
    vscode.commands.registerCommand("imde.guiConfig", async (uri?: vscode.Uri) => {
      const workspaceFolder = uri
        ? vscode.workspace.getWorkspaceFolder(uri)
        : vscode.workspace.workspaceFolders?.[0];

      if (!workspaceFolder) {
        vscode.window.showErrorMessage("Please open a workspace folder first.");
        return;
      }

      // Check .config exists
      const projDir = workspaceFolder.uri.fsPath;
      const configPath = path.join(projDir, ".config");
      if (!fs.existsSync(configPath)) {
        const action = await vscode.window.showWarningMessage(
          "No .config found. Select a defconfig to generate one.",
          "Select Defconfig"
        );
        if (action === "Select Defconfig") {
          await selectDefconfig(runner, context);
        }
        return;
      }

      // .config exists but build directory may have been cleaned — auto-configure
      const cmakeCache = path.join(projDir, "build", "CMakeCache.txt");
      if (!fs.existsSync(cmakeCache)) {
        const configured = await runManagedAction("configure", [], "IMDE Configure", {
          successMessage: "Configure completed",
          syncIntelliSense: true,
          refreshMap: true,
        });
        if (!configured) {
          return;
        }
      }

      try {
        const { MenuconfigPanel } = await import("./menuconfig/MenuconfigPanel");
        const target = extensionKconfig(projDir);
        MenuconfigPanel.createOrShow(
          context.extensionUri,
          workspaceFolder.uri,
          context,
          target ? vscode.Uri.file(target) : undefined,
          vscode.Uri.file(configPath),
        );
      } catch (error: any) {
        vscode.window.showErrorMessage(`Failed to open IMDE GUI Config: ${error.message}`);
      }
    }),

    // ---- IntelliSense ----
    vscode.commands.registerCommand("imde.setupIntelliSense", () => {
      runner.invalidateJsonCache();
      const msg = intelliSenseSync();
      if (msg) {
        vscode.window.showInformationMessage(msg);
      } else {
        vscode.window.showWarningMessage(
          "IMDE: compile_commands.json not found. Run `imde configure` first."
        );
      }
    }),

  );

  // ---- Status bar quick actions ----
  // Polling helper: refresh after terminal commands complete
  const pollRefresh = (fn: () => void, delay = 3000, retries = 3) => {
    let count = 0;
    const attempt = () => {
      fn();
      if (++count < retries) setTimeout(attempt, delay);
    };
    setTimeout(attempt, delay);
  };

  const mkBar = (text: string, cmd: string, tooltip: string, priority: number) => {
    const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, priority);
    item.command = cmd;
    item.text = text;
    item.tooltip = tooltip;
    item.show();
    return item;
  };

  const mapBar = mkBar("$(symbol-color) Map", "imde.viewMap", "View Memory Map", 95);
  const artifactsDirectory = path.join(runner.getProjectDir(), "build", "artifacts");

  async function updateMapBarVisibility() {
    try {
      const entries = await fs.promises.readdir(artifactsDirectory, { withFileTypes: true });
      const hasMap = entries.some(entry => entry.isFile() && entry.name.toLowerCase().endsWith(".map"));
      if (hasMap) { mapBar.show(); }
      else { mapBar.hide(); }
    } catch {
      mapBar.hide();
    }
  }
  refreshMapStatus = () => { void updateMapBarVisibility(); };

  const mapWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(vscode.Uri.file(runner.getProjectDir()), "build/artifacts/**/*.map"),
  );
  const refreshMapBar = () => { void updateMapBarVisibility(); };
  mapWatcher.onDidCreate(refreshMapBar);
  mapWatcher.onDidChange(refreshMapBar);
  mapWatcher.onDidDelete(refreshMapBar);
  context.subscriptions.push(mapWatcher);
  const initialMapTimer = setTimeout(updateMapBarVisibility, 2000);
  context.subscriptions.push({ dispose: () => clearTimeout(initialMapTimer) });

  context.subscriptions.push(
    mkBar(`$(terminal-bash) IMDE ${PACKAGE_JSON.version || ""}`.trim(), "imde.openEnv", "Open IMDE terminal and source environment", 100),
    mkBar("$(debug-rerun) Rebuild", "imde.fullCleanBuild", "FullClean & Build", 99),
    mkBar("$(play) Build", "imde.build", "Build", 98),
    mkBar("$(list-selection) Select", "imde.selectDefconfig", "Select Defconfig", 97),
    mkBar("$(circuit-board) Pinmux", "imde.pinmux", "Open Pinmux", 96.5),
    mkBar("$(settings) Config", "imde.guiConfig", "GUI Config", 96),
    mapBar,
  );
}

async function reportResult(runner: ImdeRunner, command: string, result: ImdeCommandResult): Promise<void> {
  if (result.code === 0 && !result.timedOut) {
    return;
  }

  const reason = result.timedOut ? "timed out" : `failed with exit code ${result.code ?? "unknown"}`;
  const action = vscode.workspace.getConfiguration("imde").get<boolean>("showOutputOnError") ?? true
    ? await vscode.window.showErrorMessage(`IMDE ${command} ${reason}.`, "Show Terminal")
    : await vscode.window.showErrorMessage(`IMDE ${command} ${reason}.`);
  if (action === "Show Terminal") {
    runner.showCommandTerminal();
  }
}

export function deactivate() {
  Logger.info("IMDE extension is now deactivated");
}
