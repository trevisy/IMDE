import * as vscode from "vscode";
import * as cp from "child_process";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { StringDecoder } from "string_decoder";

export interface ImdeCommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled?: boolean;
  commandLine: string;
}

export interface ImdeRunOptions {
  progressTitle?: string;
  progressDetail?: string;
  timeoutMs?: number;
  streamOutput?: boolean;
  displayTarget?: "terminal" | "output";
  onProgress?: (current: number, total: number, detail: string) => void;
  cancellationToken?: vscode.CancellationToken;
}

/** Canonical platform directory name matching IMDE Python detect_platform(). */
function imdePlatformDir(): string {
  if (process.platform === "win32") return "windows";
  if (process.platform === "linux") return "linux";
  if (process.platform === "darwin") {
    try {
      const cpu = os.cpus();
      // Apple Silicon models report "Apple M…" in their model name
      const isArm = cpu.length > 0 && /Apple\s+M\d/i.test(cpu[0]?.model || "");
      return isArm ? "macos-arm64" : "macos";
    } catch {
      return "macos";
    }
  }
  return process.platform;
}

export class ImdeRunner implements vscode.Disposable {
  private terminal: vscode.Terminal | undefined;
  private output = vscode.window.createOutputChannel("IMDE");
  private _projectRoot: string | null = null;
  private _projectChecked = false;
  private terminalCommandQueue: Promise<void> = Promise.resolve();
  private terminalEnvReady = false;
  private terminalEnvReadyPromise: Promise<void> | undefined;
  private static loginEnvCache: Record<string, string> | null = null;

  dispose(): void {
    this.jsonCache.clear();
    this.output.dispose();
  }

  public invalidateJsonCache(): void {
    this.jsonCache.clear();
  }

  /** Force re-detection of the IMDE project root on next access. */
  public resetProjectCheck(): void {
    this._projectChecked = false;
    this._projectRoot = null;
  }

  /** True when a valid IMDE project (containing imde.json) was resolved. */
  get isValidImdeProject(): boolean {
    this._ensureProjectChecked();
    return this._projectRoot !== null;
  }

  /** The resolved IMDE project root, or an empty string when invalid. */
  getProjectDir(): string {
    this._ensureProjectChecked();
    return this._projectRoot || "";
  }

  private _ensureProjectChecked(): void {
    if (this._projectChecked) return;
    this._projectChecked = true;

    const cfg = vscode.workspace.getConfiguration("imde");
    const configured = cfg.get<string>("projectDir")?.trim();
    if (configured) {
      const resolved = path.resolve(configured);
      if (fs.existsSync(path.join(resolved, "imde.json"))) {
        this._projectRoot = resolved;
        return;
      }
      this.output.appendLine(`IMDE: configured projectDir "${resolved}" does not contain imde.json`);
    }

    const ws = vscode.workspace.workspaceFolders;
    if (!ws?.length) {
      this._projectRoot = null;
      return;
    }

    let dir = ws[0].uri.fsPath;
    let depth = 0;
    const MAX_DEPTH = 10;
    while (dir !== path.dirname(dir) && depth < MAX_DEPTH) {
      if (fs.existsSync(path.join(dir, "imde.json"))) {
        this._projectRoot = dir;
        return;
      }
      dir = path.dirname(dir);
      depth++;
    }
    // Not found within limit — not an IMDE workspace
    this._projectRoot = null;
    this.output.appendLine(
      `IMDE: imde.json not found within ${MAX_DEPTH} levels above workspace root. Extension will stay idle.`
    );
  }

  private static loginEnvPromise: Promise<Record<string, string>> | null = null;

  /** Kick off async login-shell env capture. Non-blocking — returns immediately. */
  public static warmupEnv(): void {
    if (process.platform === "win32") {
      ImdeRunner.loginEnvCache = { ...process.env } as Record<string, string>;
      return;
    }
    if (ImdeRunner.loginEnvPromise) return;
    // Fire-and-forget: capture login-shell PATH in background
    ImdeRunner.loginEnvPromise = ImdeRunner.captureShellEnvAsync().then(env => {
      ImdeRunner.loginEnvCache = env;
      return env;
    }).catch(() => {
      // Fall back to process.env on failure
      const fallback = { ...process.env } as Record<string, string>;
      ImdeRunner.loginEnvCache = fallback;
      return fallback;
    });
  }

  private static resolveLoginEnv(_force = false): Record<string, string> {
    if (ImdeRunner.loginEnvCache) {
      return ImdeRunner.loginEnvCache;
    }
    if (process.platform === "win32") {
      ImdeRunner.loginEnvCache = { ...process.env } as Record<string, string>;
      return ImdeRunner.loginEnvCache;
    }
    // Still warming up — return process.env as fallback
    return { ...process.env } as Record<string, string>;
  }

  private static async captureShellEnvAsync(): Promise<Record<string, string>> {
    const merged = { ...process.env } as Record<string, string>;
    const shell = process.env.SHELL || "/bin/bash";

    const execShell = (args: string[], timeout: number): Promise<string> =>
      new Promise(resolve => {
        const child = cp.spawn(shell, args, {
          timeout, stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        child.stdout?.on("data", (d: Buffer) => { stdout += d.toString("utf8"); });
        child.on("close", () => resolve(stdout));
        child.on("error", () => resolve(""));
        setTimeout(() => { child.kill(); resolve(stdout); }, timeout);
      });

    const login = await execShell(["-l", "-c", "echo __PATH__:$PATH"], 3000);
    const m1 = login.match(/__PATH__:(.+)/);
    if (m1) { merged.PATH = m1[1]; }

    const interactive = await execShell(["-i", "-c", "echo __PATH__:$PATH"], 5000);
    const m2 = interactive.match(/__PATH__:(.+)/);
    if (m2) { merged.PATH = m2[1]; }

    return merged;
  }

  showOutput(): void {
    this.output.show(true);
  }

  showCommandTerminal(): void {
    if (this.terminal) {
      this.terminal.show(true);
      return;
    }
    if (!this.isValidImdeProject) {
      return;
    }
    const cfg = vscode.workspace.getConfiguration("imde");
    const termName = cfg.get<string>("terminalName") || "IMDE";
    const existing = vscode.window.terminals.find(t => t.name === termName);
    if (existing) {
      this.terminal = existing;
      existing.show(true);
    }
  }

  log(message: string): void {
    this.output.appendLine(`[${new Date().toLocaleTimeString()}] ${message}`);
  }

  /** Cached result of system Python probe — probe only once per session. */
  private static _systemPythonCache: string | null | undefined;

  /** Find the Python executable to use (bundled or system). */
  private python(): string | null {
    if (!this.isValidImdeProject) return null;
    const proj = this._projectRoot!;
    const platformDir = imdePlatformDir();
    const bundled = path.join(proj, "tools", "python", platformDir,
      platformDir === "windows" ? "python.exe" : "bin/python3");
    if (fs.existsSync(bundled)) {
      return bundled;
    }

    // Probe for system Python once per session (spawnSync is blocking).
    if (ImdeRunner._systemPythonCache !== undefined) {
      return ImdeRunner._systemPythonCache;
    }

    const env = ImdeRunner.resolveLoginEnv();
    for (const name of platformDir === "windows" ? ["python", "python3"] : ["python3", "python"]) {
      const result = cp.spawnSync(name, ["--version"], { env, timeout: 3000 });
      if (result.status === 0) {
        ImdeRunner._systemPythonCache = name;
        return name;
      }
    }
    ImdeRunner._systemPythonCache = null;
    return null;
  }

  private imdePy(): string {
    return path.join(this._projectRoot || "", "tools", "imde", "imde.py");
  }

  private imdeBin(): string | null {
    const proj = this._projectRoot;
    if (!proj) return null;
    const candidates = process.platform === "win32"
      ? ["tools/imde/bin/imde.cmd", "tools/imde/bin/imde.bat"]
      : ["tools/imde/bin/imde"];
    for (const rel of candidates) {
      const bin = path.join(proj, rel);
      if (fs.existsSync(bin)) {
        return bin;
      }
    }
    return null;
  }

  private extensionArgs(proj: string): string[] {
    const manifests: string[] = [];
    try {
      for (const entry of fs.readdirSync(proj, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const manifest = path.join(proj, entry.name, "imde-extension.json");
        if (fs.existsSync(manifest)) manifests.push(manifest);
      }
    } catch { /* optional extensions are best-effort here; CLI reports invalid manifests */ }
    return manifests.flatMap(manifest => ["--extension", manifest]);
  }

  private spawnImdeBin(bin: string, args: string[]): { exe: string; args: string[] } {
    if (process.platform === "win32") {
      return { exe: bin, args };
    }
    try {
      if ((fs.statSync(bin).mode & 0o111) === 0) {
        return { exe: fs.existsSync("/bin/bash") ? "/bin/bash" : "bash", args: [bin, ...args] };
      }
    } catch { /* fall through */ }
    return { exe: bin, args };
  }

  private getSharedTerminal(proj: string): { terminal: vscode.Terminal; created: boolean } {
    const cfg = vscode.workspace.getConfiguration("imde");
    const termName = cfg.get<string>("terminalName") || "IMDE";

    const isUsable = (terminal: vscode.Terminal | undefined): terminal is vscode.Terminal =>
      !!terminal && terminal.exitStatus === undefined;

    if (isUsable(this.terminal)) {
      return { terminal: this.terminal, created: false };
    }
    this.terminalEnvReady = false;
    this.terminalEnvReadyPromise = undefined;

    const existing = vscode.window.terminals.find(t => t.name === termName && t.exitStatus === undefined);
    if (existing) {
      this.terminal = existing;
      this.terminalEnvReady = false;
      this.terminalEnvReadyPromise = undefined;
      return { terminal: existing, created: false };
    }

    this.terminal = vscode.window.createTerminal({
      name: termName,
      cwd: proj,
    });
    this.terminalEnvReady = false;
    this.terminalEnvReadyPromise = undefined;
    return { terminal: this.terminal, created: true };
  }

  /** Run IMDE in the shared terminal. Use this for interactive commands. */
  runTerminal(cmd: string, args: string[] = [], opts?: { show?: boolean }): void {
    if (!this.isValidImdeProject) {
      vscode.window.showWarningMessage("IMDE: not an IMDE project (imde.json not found).");
      return;
    }
    const proj = this._projectRoot!;
    const { terminal } = this.getSharedTerminal(proj);
    const object = vscode.workspace.getConfiguration("imde").get<string>("buildObject") || "default";
    const objectCommands = new Set(["status", "artifacts", "configure", "clean", "fullclean", "menuconfig"]);
    const effectiveArgs = objectCommands.has(cmd) ? [...args, object] : args;
    if (cmd) {
      void this.ensureTerminalEnv(proj).then(() => {
        terminal.sendText(this.formatVisibleImdeCommand(cmd, effectiveArgs));
      });
    }
    if (opts?.show) {
      terminal.show(true);
    }
  }

  /** Open the shared IMDE terminal and source the environment script.
   *  Call this to ensure the shell can run `imde` commands directly. */
  openEnvTerminal(show = true): void {
    if (!this.isValidImdeProject) {
      vscode.window.showWarningMessage("IMDE: not an IMDE project (imde.json not found).");
      return;
    }
    const proj = this._projectRoot!;
    const { terminal } = this.getSharedTerminal(proj);

    void this.ensureTerminalEnv(proj);
    if (show) {
      terminal.show(true);
    }
  }

  /** Source the environment on first use, then run doctor on later clicks. */
  openEnvOrRunDoctor(show = true): void {
    if (!this.isValidImdeProject) {
      vscode.window.showWarningMessage("IMDE: not an IMDE project (imde.json not found).");
      return;
    }
    const proj = this._projectRoot!;
    const { terminal } = this.getSharedTerminal(proj);

    if (this.terminalEnvReady) {
      terminal.sendText(this.formatVisibleImdeCommand("doctor", []));
    } else {
      void this.ensureTerminalEnv(proj);
    }
    if (show) {
      terminal.show(true);
    }
  }

  /** Source the full IMDE environment script once so the terminal can run short `imde ...` commands. */
  private ensureTerminalEnv(proj: string): Promise<void> {
    if (this.terminalEnvReady) {
      return Promise.resolve();
    }
    if (this.terminalEnvReadyPromise) {
      return this.terminalEnvReadyPromise;
    }

    const { terminal } = this.getSharedTerminal(proj);
    const sourceCmd = this.sourceCommand(proj);
    if (!sourceCmd) {
      this.terminalEnvReady = true;
      return Promise.resolve();
    }

    const run = async () => {
      const shellIntegration = await this.waitForShellIntegration(terminal, 3000);
      if (shellIntegration) {
        await this.executeTerminalSetupCommand(terminal, shellIntegration, sourceCmd);
      } else {
        terminal.sendText(sourceCmd);
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      this.terminalEnvReady = true;
    };

    this.terminalEnvReadyPromise = run().finally(() => {
      this.terminalEnvReadyPromise = undefined;
    });
    return this.terminalEnvReadyPromise;
  }

  private sourceCommand(proj: string, shellOverride?: string): string | null {
    const imdeDir = path.join(proj, "tools", "imde");
    const psEnv = path.join(imdeDir, "env.ps1");
    const shEnv = path.join(imdeDir, "env.sh");
    const shell = (shellOverride || vscode.env.shell || "").toLowerCase();

    if (shell.includes("powershell") || shell.includes("pwsh")) {
      return fs.existsSync(psEnv) ? `. ${this.quoteTerminalArg(psEnv, shell)}` : null;
    }
    if (process.platform === "win32" && shell.includes("cmd")) {
      return null;
    }

    // bash / zsh — use env.sh which auto-detects
    if (!fs.existsSync(shEnv)) {
      return null;
    }
    const sourceBuiltin = shell.includes("bash") || shell.includes("zsh") ? "source" : ".";
    return `${sourceBuiltin} ${this.quoteTerminalArg(shEnv, shell)}`;
  }

  run(cmd: string, args: string[] = [], opts?: { show?: boolean }): void {
    this.runTerminal(cmd, args, opts);
  }

  async runCommand(cmd: string, args: string[] = [], opts: ImdeRunOptions = {}): Promise<ImdeCommandResult> {
    const run = async (token = opts.cancellationToken) => {
      if (token?.isCancellationRequested) {
        return {
          code: null,
          stdout: "",
          stderr: "",
          timedOut: false,
          cancelled: true,
          commandLine: cmd,
        } satisfies ImdeCommandResult;
      }
      this.invalidateJsonCache();
      const result = await this.execute(cmd, args, {
        json: false,
        streamOutput: opts.streamOutput ?? true,
        displayTarget: opts.displayTarget ?? "terminal",
        timeoutMs: opts.timeoutMs ?? this.commandTimeoutMs(),
        onProgress: opts.onProgress,
        cancellationToken: token,
      });
      this.invalidateJsonCache();
      return result;
    };

    if (!opts.progressTitle) {
      return run();
    }

    return vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: opts.progressTitle, cancellable: true },
      async (progress, token) => {
        const started = Date.now();
        progress.report({ message: opts.progressDetail ?? "Starting..." });
        const timer = setInterval(() => {
          const elapsed = Math.max(1, Math.floor((Date.now() - started) / 1000));
          progress.report({ message: `${opts.progressDetail ?? "Running"} (${elapsed}s)` });
        }, 1000);

        try {
          const result = await run(token);
          const elapsed = Math.max(0, Math.floor((Date.now() - started) / 1000));
          progress.report({
            message: result.code === 0 && !result.timedOut
              ? `Completed in ${elapsed}s`
              : result.cancelled
                ? `Cancelled after ${elapsed}s`
                : result.timedOut
                  ? `Timed out after ${elapsed}s`
                  : `Failed after ${elapsed}s`,
          });
          return result;
        } finally {
          clearInterval(timer);
        }
      }
    );
  }

  private jsonCache = new Map<string, { data: any; ts: number }>();
  private static readonly CACHE_TTL = 10000;

  async captureJson<T = any>(cmd: string, args: string[] = []): Promise<T | null> {
    if (!this.isValidImdeProject) return null;
    const cacheKey = cmd + "|" + args.join(",");
    const cached = this.jsonCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < ImdeRunner.CACHE_TTL) {
      return cached.data as T;
    }

    const result = await this.execute(cmd, args, {
      json: true,
      streamOutput: false,
      displayTarget: "output",
      timeoutMs: this.captureTimeoutMs(),
    });

    if (result.code !== 0) {
      const brief = result.stderr
        ? result.stderr.split('\n').filter(l => !l.startsWith('  File ') && !l.startsWith('    ')).slice(-3).join('\n').trim()
        : '';
      this.output.appendLine(`IMDE captureJson(${cmd}) failed: exit ${result.code}${brief ? ' — ' + brief : ''}`);
      return null;
    }

    try {
      const data = JSON.parse(result.stdout) as T;
      this.jsonCache.set(cacheKey, { data, ts: Date.now() });
      return data;
    } catch {
      this.output.appendLine(`IMDE captureJson(${cmd}) returned invalid JSON.`);
      this.output.appendLine(result.stdout.slice(0, 500));
      return null;
    }
  }

  private execute(
    cmd: string,
    args: string[],
    opts: {
      json: boolean;
      streamOutput: boolean;
      displayTarget: "terminal" | "output";
      timeoutMs: number;
      onProgress?: (current: number, total: number, detail: string) => void;
      cancellationToken?: vscode.CancellationToken;
    }
  ): Promise<ImdeCommandResult> {
    if (!this.isValidImdeProject) {
      return Promise.resolve({ code: null, stdout: "", stderr: "Not an IMDE project", timedOut: false, commandLine: "" });
    }
    const proj = this._projectRoot!;
    const imdeBin = this.imdeBin();
    const object = vscode.workspace.getConfiguration("imde").get<string>("buildObject") || "default";
    const objectCommands = new Set(["status", "artifacts", "configure", "clean", "fullclean", "menuconfig"]);
    const effectiveArgs = objectCommands.has(cmd) ? [...args, object] : args;
    const extensionArgs = this.extensionArgs(proj);

    let spawnArgs: string[];
    let spawnExe: string;
    if (imdeBin) {
      const s = this.spawnImdeBin(imdeBin, [
        "--project-dir", proj,
        ...extensionArgs,
        ...(opts.json ? ["--json"] : []),
        cmd,
        ...effectiveArgs,
      ]);
      spawnExe = s.exe;
      spawnArgs = s.args;
    } else {
      const py = this.python();
      const imde = this.imdePy();
      if (!py) {
        vscode.window.showErrorMessage("Python not found");
        return Promise.resolve({ code: null, stdout: "", stderr: "Python not found", timedOut: false, commandLine: "" });
      }
      if (!fs.existsSync(imde)) {
        const message = `IMDE CLI not found: ${imde}`;
        vscode.window.showErrorMessage(message);
        return Promise.resolve({ code: null, stdout: "", stderr: message, timedOut: false, commandLine: "" });
      }
      spawnExe = py;
      spawnArgs = [imde, "--project-dir", proj, ...extensionArgs, ...(opts.json ? ["--json"] : []), cmd, ...effectiveArgs];
    }

    const commandLine = this.formatForLog([spawnExe, ...spawnArgs]);

    if (opts.streamOutput) {
      if (opts.displayTarget === "output") {
        this.output.appendLine(`> ${commandLine}`);
      }
    }

    if (opts.streamOutput && opts.displayTarget === "terminal") {
      return this.executeInSharedTerminal([spawnExe, ...spawnArgs], {
        cwd: proj,
        commandLine,
        timeoutMs: opts.timeoutMs,
        onProgress: opts.onProgress,
        cancellationToken: opts.cancellationToken,
      });
    }

    return new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let cancelled = false;
      let settled = false;

      const loginEnv = ImdeRunner.resolveLoginEnv();
      const proc = cp.spawn(spawnExe, spawnArgs, {
        cwd: proj,
        env: {
          ...loginEnv,
          PYTHONIOENCODING: process.env.PYTHONIOENCODING || "utf-8",
        },
      });
      let cancelSubscription: vscode.Disposable | undefined;
      const finish = (result: ImdeCommandResult) => {
        if (settled) { return; }
        settled = true;
        if (timer) { clearTimeout(timer); }
        cancelSubscription?.dispose();
        resolve(result);
      };

      const timer = opts.timeoutMs > 0
        ? setTimeout(() => { timedOut = true; proc.kill(); }, opts.timeoutMs)
        : undefined;
      cancelSubscription = opts.cancellationToken?.onCancellationRequested(() => {
        cancelled = true;
        try { proc.kill(); } catch { /* best-effort */ }
        finish({ code: null, stdout, stderr, timedOut, cancelled, commandLine });
      });

      proc.stdout!.on("data", (d: Buffer) => {
        const text = d.toString();
        stdout += text;
        if (opts.streamOutput) { this.output.append(text); }
        parseProgress(text);
      });
      const parseProgress = (text: string) => {
        if (!opts.onProgress) return;
        const m = text.match(/\[(\d+)\/(\d+)\]\s+(.+)/);
        if (m) {
          opts.onProgress(parseInt(m[1], 10), parseInt(m[2], 10), m[3].trim());
        }
      };

      proc.stderr!.on("data", (d: Buffer) => {
        const text = d.toString();
        stderr += text;
        if (opts.streamOutput) { this.output.append(text); }
        parseProgress(text);
      });
      proc.on("error", (err) => {
        try { proc.kill(); } catch { /* best-effort */ }
        finish({ code: null, stdout, stderr: stderr + err.message, timedOut, cancelled, commandLine });
      });
      proc.on("close", (code) => {
        if (opts.streamOutput) {
          this.output.appendLine("");
          this.output.appendLine(timedOut ? `Timed out: ${commandLine}` : `Exit code: ${code ?? "unknown"}`);
        }
        finish({ code, stdout, stderr, timedOut, cancelled, commandLine });
      });
    });
  }

  private executeInSharedTerminal(
    commandTokens: string[],
    opts: {
      cwd: string;
      commandLine: string;
      timeoutMs: number;
      onProgress?: (current: number, total: number, detail: string) => void;
      cancellationToken?: vscode.CancellationToken;
    }
  ): Promise<ImdeCommandResult> {
    if (opts.cancellationToken?.isCancellationRequested) {
      return Promise.resolve({
        code: null,
        stdout: "",
        stderr: "",
        timedOut: false,
        cancelled: true,
        commandLine: opts.commandLine,
      });
    }

    // Shell Integration can miss execution-end events after long builds, leaving the
    // shared command queue permanently blocked. The wrapper script provides an explicit
    // exit code and PID on every platform, so command completion never depends on that event.
    const run = async () => {
      if (opts.cancellationToken?.isCancellationRequested) {
        return {
          code: null,
          stdout: "",
          stderr: "",
          timedOut: false,
          cancelled: true,
          commandLine: opts.commandLine,
        } satisfies ImdeCommandResult;
      }
      return this.executeWithTerminalScript(commandTokens, opts);
    };

    const queued = this.terminalCommandQueue.catch(() => undefined).then(run);
    this.terminalCommandQueue = queued.then(() => undefined, () => undefined);
    return queued;
  }

  private waitForShellIntegration(
    terminal: vscode.Terminal,
    timeoutMs: number,
  ): Promise<vscode.TerminalShellIntegration | undefined> {
    if (terminal.shellIntegration) {
      return Promise.resolve(terminal.shellIntegration);
    }

    return new Promise(resolve => {
      const timer = setTimeout(() => {
        subscription.dispose();
        resolve(undefined);
      }, timeoutMs);
      const subscription = vscode.window.onDidChangeTerminalShellIntegration(event => {
        if (event.terminal === terminal) {
          clearTimeout(timer);
          subscription.dispose();
          resolve(event.shellIntegration);
        }
      });
    });
  }

  private executeTerminalSetupCommand(
    terminal: vscode.Terminal,
    shellIntegration: vscode.TerminalShellIntegration,
    commandLine: string,
  ): Promise<void> {
    return new Promise(resolve => {
      let execution: vscode.TerminalShellExecution | undefined;
      let settled = false;
      const finish = () => {
        if (settled) { return; }
        settled = true;
        clearTimeout(timer);
        subscription.dispose();
        resolve();
      };
      const subscription = vscode.window.onDidEndTerminalShellExecution(event => {
        if (event.terminal === terminal && event.execution === execution) {
          finish();
        }
      });
      const timer = setTimeout(finish, 10000);
      execution = shellIntegration.executeCommand(commandLine);
    });
  }

  private executeWithTerminalScript(
    commandTokens: string[],
    opts: {
      cwd: string;
      commandLine: string;
      timeoutMs: number;
      onProgress?: (current: number, total: number, detail: string) => void;
      cancellationToken?: vscode.CancellationToken;
    },
  ): Promise<ImdeCommandResult> {
    return new Promise(resolve => {
      const { terminal } = this.getSharedTerminal(opts.cwd);
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "imde-"));
      const logFile = path.join(tempDir, "command.log");
      const exitFile = path.join(tempDir, "exit.code");
      const pidFile = path.join(tempDir, "command.pid");
      const visibleCommand = this.formatManagedTerminalCommand(commandTokens);
      const script = this.createTerminalScript(
        visibleCommand,
        opts.cwd,
        logFile,
        exitFile,
        pidFile,
        opts.commandLine,
      );
      let stdout = "";
      let logOffset = 0;
      let missingExitSince = 0;
      let exitSeenSince = 0;
      let settled = false;
      const decoder = new StringDecoder("utf8");

      const consumeLog = (flush = false) => {
        if (!fs.existsSync(logFile)) { return; }
        const size = fs.statSync(logFile).size;
        if (size <= logOffset) {
          if (flush) {
            const tail = decoder.end();
            if (tail) {
              stdout += tail;
              this.parseProgress(tail, opts.onProgress);
            }
          }
          return;
        }
        const fd = fs.openSync(logFile, "r");
        try {
          while (logOffset < size) {
            const buffer = Buffer.alloc(Math.min(256 * 1024, size - logOffset));
            const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, logOffset);
            if (bytesRead <= 0) { break; }
            logOffset += bytesRead;
            const clean = this.stripTerminalControl(decoder.write(buffer.subarray(0, bytesRead)));
            if (!clean) { continue; }
            stdout += clean;
            this.parseProgress(clean, opts.onProgress);
          }
        } finally {
          fs.closeSync(fd);
        }
      };

      let cancelSubscription: vscode.Disposable | undefined;
      let closeSubscription: vscode.Disposable | undefined;
      const finish = (code: number | null, timedOut: boolean, cancelled = false) => {
        if (settled) { return; }
        settled = true;
        clearTimeout(startupTimer);
        if (timer) { clearTimeout(timer); }
        clearInterval(poll);
        cancelSubscription?.dispose();
        closeSubscription?.dispose();
        consumeLog(true);
        if (timedOut) {
          terminal.sendText("\x03", false);
        }
        this.cleanupTempDir(tempDir);
        resolve({
          code,
          stdout,
          stderr: "",
          timedOut,
          cancelled,
          commandLine: opts.commandLine,
        });
      };

      const poll = setInterval(() => {
        consumeLog();
        const pid = this.readProcessId(pidFile);
        if (fs.existsSync(exitFile)) {
          const raw = fs.readFileSync(exitFile, "utf8").trim();
          const parsed = Number.parseInt(raw, 10);
          if (pid === undefined || !this.isProcessAlive(pid)) {
            consumeLog();
            finish(Number.isFinite(parsed) ? parsed : null, false);
            return;
          }
          if (exitSeenSince === 0) {
            exitSeenSince = Date.now();
          } else if (Date.now() - exitSeenSince >= 1500) {
            // The command has published its exit code. Some shells keep their host
            // process alive briefly after the pipeline; that must not block the queue.
            consumeLog();
            finish(Number.isFinite(parsed) ? parsed : null, false);
          }
          return;
        }

        if (pid !== undefined && !this.isProcessAlive(pid)) {
          // Ctrl+C, terminal profile failures, and shell shutdown can prevent the
          // wrapper from writing exit.code. Once the wrapper is gone, release the queue.
          if (missingExitSince === 0) {
            missingExitSince = Date.now();
          } else if (Date.now() - missingExitSince >= 750) {
            this.output.appendLine(`IMDE command process ${pid} exited without writing ${exitFile}`);
            finish(null, false);
          }
        } else {
          missingExitSince = 0;
        }
      }, 250);

      const timer = opts.timeoutMs > 0
        ? setTimeout(() => finish(null, true), opts.timeoutMs)
        : undefined;
      const startupTimer = setTimeout(() => {
        if (!fs.existsSync(pidFile)) {
          this.output.appendLine("IMDE terminal command did not start within 15 seconds");
          finish(null, false);
        }
      }, 15000);

      cancelSubscription = opts.cancellationToken?.onCancellationRequested(() => {
        terminal.sendText("\x03", false);
        finish(null, false, true);
      });
      closeSubscription = vscode.window.onDidCloseTerminal(closed => {
        if (closed === terminal) {
          finish(null, false);
        }
      });

      terminal.show(true);
      terminal.sendText(script.commandLine);
    });
  }

  private createTerminalScript(
    visibleCommand: string,
    cwd: string,
    logFile: string,
    exitFile: string,
    pidFile: string,
    commandLine: string,
  ): { commandLine: string } {
    const shell = (vscode.env.shell || "").toLowerCase();
    if (process.platform === "win32" && !this.isUnixLikeShell(shell)) {
      const scriptPath = path.join(path.dirname(logFile), "run-imde.ps1");
      const psShell = shell.includes("powershell") || shell.includes("pwsh") ? shell : "powershell";
      const content = [
        "$ErrorActionPreference = 'Continue'",
        `Write-Host ${this.quoteTerminalArg(`[IMDE] > ${commandLine}`, psShell)}`,
        `Set-Location -LiteralPath ${this.quoteTerminalArg(cwd, psShell)}`,
        `[System.IO.File]::WriteAllText(${this.quoteTerminalArg(pidFile, psShell)}, [string]$PID)`,
        `[System.IO.File]::WriteAllText(${this.quoteTerminalArg(logFile, psShell)}, '')`,
        "if (-not $env:PYTHONIOENCODING) { $env:PYTHONIOENCODING = 'utf-8' }",
        `${visibleCommand} 2>&1 | Tee-Object -FilePath ${this.quoteTerminalArg(logFile, psShell)}`,
        "$__imde_code = if ($null -ne $LASTEXITCODE) { [int]$LASTEXITCODE } elseif ($?) { 0 } else { 1 }",
        `Set-Content -LiteralPath ${this.quoteTerminalArg(exitFile, psShell)} -Value $__imde_code -Encoding ascii`,
        "",
      ].join("\n");
      fs.writeFileSync(scriptPath, content, "utf8");

      if (shell.includes("cmd")) {
        return { commandLine: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${scriptPath.replace(/"/g, '""')}"` };
      }
      const pwshExecutable = psShell.includes("pwsh") ? psShell : "powershell.exe";
      return {
        commandLine: `& ${this.quoteTerminalArg(pwshExecutable, psShell)}`
          + ` -NoProfile -ExecutionPolicy Bypass -File ${this.quoteTerminalArg(scriptPath, psShell)}`,
      };
    }

    const scriptPath = path.join(path.dirname(logFile), "run-imde.sh");
    const shShell = shell || "sh";
    const content = [
      "#!/bin/sh",
      `printf '%s\\n' ${this.quoteTerminalArg(`[IMDE] > ${commandLine}`, shShell)}`,
      `cd ${this.quoteTerminalArg(cwd, shShell)} || { printf '%s\\n' 'IMDE: failed to enter project directory' | tee ${this.quoteTerminalArg(logFile, shShell)}; printf '%s' 1 > ${this.quoteTerminalArg(exitFile, shShell)}; exit 1; }`,
      `printf '%s' "$$" > ${this.quoteTerminalArg(pidFile, shShell)}`,
      `: > ${this.quoteTerminalArg(logFile, shShell)}`,
      "if [ -z \"${PYTHONIOENCODING+x}\" ]; then export PYTHONIOENCODING=utf-8; fi",
      `{ ${visibleCommand} 2>&1; printf '%s' "$?" > ${this.quoteTerminalArg(exitFile, shShell)}; } | tee ${this.quoteTerminalArg(logFile, shShell)}`,
      "",
    ].join("\n");
    fs.writeFileSync(scriptPath, content, { encoding: "utf8", mode: 0o700 });
    return { commandLine: `sh ${this.quoteTerminalArg(scriptPath, shShell)}` };
  }

  private readProcessId(pidFile: string): number | undefined {
    try {
      const pid = Number.parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10);
      return Number.isFinite(pid) && pid > 0 ? pid : undefined;
    } catch {
      return undefined;
    }
  }

  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  }

  private isUnixLikeShell(shell: string): boolean {
    const normalized = shell.replace(/\\/g, "/").toLowerCase();
    const name = normalized.split("/").pop() || normalized;
    return ["bash", "bash.exe", "zsh", "zsh.exe", "sh", "sh.exe", "fish", "fish.exe"].includes(name);
  }

  private captureTimeoutMs(): number {
    return vscode.workspace.getConfiguration("imde").get<number>("captureTimeoutMs") ?? 15000;
  }

  private commandTimeoutMs(): number {
    return vscode.workspace.getConfiguration("imde").get<number>("commandTimeoutMs") ?? 0;
  }

  private formatForLog(tokens: string[]): string {
    return tokens.map((token) => token.includes(" ") ? `"${token}"` : token).join(" ");
  }

  private formatVisibleImdeCommand(cmd: string, args: string[]): string {
    const shell = (vscode.env.shell || "").toLowerCase();
    const tokens = ["imde", ...this.extensionArgs(this._projectRoot || ""), cmd, ...args].filter(Boolean);
    return tokens.map((token) => this.quoteTerminalArg(token, shell, { bareSimple: true })).join(" ");
  }

  private formatManagedTerminalCommand(tokens: string[]): string {
    const shell = (vscode.env.shell || "").toLowerCase();
    const command = tokens
      .map((token) => this.quoteTerminalArg(token, shell, { bareSimple: true }))
      .join(" ");
    return shell.includes("powershell") || shell.includes("pwsh") ? `& ${command}` : command;
  }

  private parseProgress(
    text: string,
    onProgress?: (current: number, total: number, detail: string) => void,
  ): void {
    if (!onProgress) return;
    const m = text.match(/\[(\d+)\/(\d+)\]\s+(.+)/);
    if (m) {
      onProgress(parseInt(m[1], 10), parseInt(m[2], 10), m[3].trim());
    }
  }

  private stripTerminalControl(text: string): string {
    // eslint-disable-next-line no-control-regex
    return text
      .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n");
  }

  private cleanupTempDir(dir: string): void {
    setTimeout(() => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup; stale temp logs are harmless.
      }
    }, 1000);
  }

  private quoteTerminalArg(token: string, shell: string, options?: { bareSimple?: boolean }): string {
    if (!token) { return "''"; }
    if (options?.bareSimple && /^[A-Za-z0-9_./:@%+=,-]+$/.test(token)) {
      return token;
    }
    if (shell.includes("powershell") || shell.includes("pwsh")) {
      return `'${token.replace(/'/g, "''")}'`;
    }
    if (process.platform === "win32" && shell.includes("cmd")) {
      return `"${token.replace(/"/g, '\\"')}"`;
    }
    return `'${token.replace(/'/g, "'\\''")}'`;
  }
}
