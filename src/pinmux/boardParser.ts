import * as fs from "fs";
import * as path from "path";
import { boardSignalMacro } from "./boardGenerator";
import { PinmuxDefinition } from "./types";

export type BoardPinmuxKind = "function" | "gpio";
export type BoardGpioMode = "input" | "output-low" | "output-high";
export type BoardPinPull = "none" | "up" | "down";
export type BoardPinSpeed = "low" | "high";

export interface BoardPinmuxEntry {
  owner: string;
  pinId: string;
  port: string;
  pinIndex: number;
  kind: BoardPinmuxKind;
  mux?: number;
  gpioMode?: BoardGpioMode;
  activeLevel?: "low" | "high";
  pull: BoardPinPull;
  speed: BoardPinSpeed;
  driveStrength_mA: number;
  schmitt: boolean;
  line: number;
  signal?: string;
}

export interface BoardPinmuxIssue {
  line: number;
  message: string;
}

export interface BoardPinmuxDocument {
  filePath: string;
  entries: BoardPinmuxEntry[];
  issues: BoardPinmuxIssue[];
}

interface MacroCall {
  arguments: string[];
  line: number;
  macro: "BSP_GPIO_PINMUX" | "IM_GPIO_PINMUX_CONFIG";
}

export interface BoardPinSignalEntry {
  macro: string;
  pinId: string;
  activeLevel: "low" | "high";
  line: number;
}

export function parseBoardPins(source: string): BoardPinSignalEntry[] {
  const pattern = /^\s*#define\s+(BOARD_[A-Z0-9_]+)\s+(?:(?:GPIO_SIGNAL\(\s*GPIO([A-Z])\s*,\s*GPIO_PIN_(\d+))|(?:IM_GPIO_SIGNAL\(\s*IM_GPIO_PORT_([A-Z])\s*,\s*(\d+)U?))\s*,\s*(true|false)\s*\)/gm;
  const entries: BoardPinSignalEntry[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const port = match[2] || match[4];
    const pinIndex = match[3] || match[5];
    entries.push({
      macro: match[1],
      pinId: `P${port}${String(Number(pinIndex)).padStart(2, "0")}`,
      activeLevel: match[6] === "true" ? "high" : "low",
      line: 1 + source.slice(0, match.index).split("\n").length - 1,
    });
  }
  return entries;
}

function maskComments(source: string): string {
  const result = source.split("");
  let index = 0;
  let quote = "";

  while (index < source.length) {
    const character = source[index];
    const next = source[index + 1];
    if (quote) {
      if (character === "\\") {
        index += 2;
        continue;
      }
      if (character === quote) quote = "";
      index++;
      continue;
    }
    if (character === "\"" || character === "'") {
      quote = character;
      index++;
      continue;
    }
    if (character === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") {
        result[index] = " ";
        index++;
      }
      continue;
    }
    if (character === "/" && next === "*") {
      result[index++] = " ";
      result[index++] = " ";
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
        if (source[index] !== "\r" && source[index] !== "\n") result[index] = " ";
        index++;
      }
      if (index < source.length) {
        result[index++] = " ";
        result[index++] = " ";
      }
      continue;
    }
    index++;
  }

  return result.join("");
}

function splitMacroArguments(source: string, masked: string, openIndex: number): { arguments: string[]; endIndex: number } | undefined {
  const argumentsList: string[] = [];
  let argumentStart = openIndex + 1;
  let depth = 1;
  let quote = "";

  for (let index = openIndex + 1; index < source.length; index++) {
    const character = source[index];
    if (quote) {
      if (character === "\\") {
        index++;
        continue;
      }
      if (character === quote) quote = "";
      continue;
    }
    if (character === "\"" || character === "'") {
      quote = character;
      continue;
    }

    const visibleCharacter = masked[index];
    if (visibleCharacter === "(") {
      depth++;
    } else if (visibleCharacter === ")") {
      depth--;
      if (depth === 0) {
        argumentsList.push(source.slice(argumentStart, index).trim());
        return { arguments: argumentsList, endIndex: index + 1 };
      }
    } else if (visibleCharacter === "," && depth === 1) {
      argumentsList.push(source.slice(argumentStart, index).trim());
      argumentStart = index + 1;
    }
  }

  return undefined;
}

function extractMacroCalls(source: string, issues: BoardPinmuxIssue[]): MacroCall[] {
  const masked = maskComments(source);
  const pattern = /\b(BSP_GPIO_PINMUX|IM_GPIO_PINMUX_CONFIG)\s*\(/g;
  const calls: MacroCall[] = [];
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(masked)) !== null) {
    const macro = match[1] as MacroCall["macro"];
    const openIndex = masked.indexOf("(", match.index);
    const line = 1 + source.slice(0, match.index).split("\n").length - 1;
    const parsed = splitMacroArguments(source, masked, openIndex);
    if (!parsed) {
      issues.push({ line, message: `Unterminated ${macro} call.` });
      break;
    }
    calls.push({ arguments: parsed.arguments, line, macro });
    pattern.lastIndex = parsed.endIndex;
  }

  return calls;
}

function parseCString(value: string): string | undefined {
  if (!/^"(?:\\.|[^"\\])*"$/.test(value)) return undefined;
  try {
    return JSON.parse(value) as string;
  } catch {
    return undefined;
  }
}

function parseEntry(call: MacroCall, issues: BoardPinmuxIssue[]): BoardPinmuxEntry | undefined {
  if (call.arguments.length !== 8) {
    issues.push({ line: call.line, message: `${call.macro} expects 8 arguments, got ${call.arguments.length}.` });
    return undefined;
  }

  const [ownerArg, portArg, pinArg, modeArg, pullArg, speedArg, driveArg, schmittArg] = call.arguments;
  const isLegacy = call.macro === "BSP_GPIO_PINMUX";
  const enumPrefix = isLegacy ? "HAL_GPIO" : "IM_GPIO";
  const owner = parseCString(ownerArg);
  const portMatch = isLegacy ? /^GPIO([A-Z])$/.exec(portArg) : /^IM_GPIO_PORT_([A-Z])$/.exec(portArg);
  const pinMatch = /^(\d+)U?$/.exec(pinArg);
  const functionMatch = new RegExp(`^${enumPrefix}_FUNCTION_([0-3])$`).exec(modeArg);
  const pullMatch = new RegExp(`^${enumPrefix}_PULL_(NONE|UP|DOWN)$`).exec(pullArg);
  const speedMatch = isLegacy
    ? new RegExp(`^${enumPrefix}_SPEED_(LOW|HIGH)$`).exec(speedArg)
    : new RegExp(`^${enumPrefix}_SLEW_(LOW|HIGH)$`).exec(speedArg);
  const driveMatch = new RegExp(`^${enumPrefix}_DRIVE_STRENGTH_(\\d+)MA$`).exec(driveArg);
  const gpioModes: Record<string, BoardGpioMode> = {
    HAL_GPIO_FUNCTION_INPUT: "input",
    HAL_GPIO_FUNCTION_OUTPUT_LOW: "output-low",
    HAL_GPIO_FUNCTION_OUTPUT_HIGH: "output-high",
    IM_GPIO_FUNCTION_INPUT: "input",
    IM_GPIO_FUNCTION_OUTPUT_LOW: "output-low",
    IM_GPIO_FUNCTION_OUTPUT_HIGH: "output-high",
  };
  const gpioMode = gpioModes[modeArg];

  if (!owner || !portMatch || !pinMatch || (!functionMatch && !gpioMode) || !pullMatch || !speedMatch || !driveMatch || (schmittArg !== "true" && schmittArg !== "false")) {
    issues.push({ line: call.line, message: `Unsupported ${call.macro} argument.` });
    return undefined;
  }

  const pinIndex = Number(pinMatch[1]);
  const port = portMatch[1];
  return {
    owner,
    pinId: `P${port}${String(pinIndex).padStart(2, "0")}`,
    port,
    pinIndex,
    kind: functionMatch ? "function" : "gpio",
    mux: functionMatch ? Number(functionMatch[1]) : undefined,
    gpioMode,
    pull: pullMatch[1].toLowerCase() as BoardPinPull,
    speed: speedMatch[1].toLowerCase() as BoardPinSpeed,
    driveStrength_mA: Number(driveMatch[1]),
    schmitt: schmittArg === "true",
    line: call.line,
  };
}

export function parseBoardPinmux(
  source: string,
  filePath: string,
  definition: PinmuxDefinition,
  boardPinsSource?: string,
): BoardPinmuxDocument {
  const issues: BoardPinmuxIssue[] = [];
  const entries = extractMacroCalls(source, issues)
    .map(call => parseEntry(call, issues))
    .filter((entry): entry is BoardPinmuxEntry => entry !== undefined);
  const pinsById = new Map(definition.pins.map(pin => [pin.id, pin]));
  const seenPins = new Map<string, number>();
  const boardSignals = new Map(
    boardPinsSource === undefined
      ? []
      : parseBoardPins(boardPinsSource).map(entry => [`${entry.macro}:${entry.pinId}`, entry] as const),
  );

  for (const entry of entries) {
    const previousLine = seenPins.get(entry.pinId);
    if (previousLine !== undefined) {
      issues.push({ line: entry.line, message: `${entry.pinId} is already configured on line ${previousLine}.` });
    } else {
      seenPins.set(entry.pinId, entry.line);
    }

    const pin = pinsById.get(entry.pinId);
    if (!pin) {
      issues.push({ line: entry.line, message: `${entry.pinId} is not present in ${definition.package.id}.` });
      continue;
    }
    if (entry.kind === "gpio") {
      let ownerMacro: string;
      try {
        ownerMacro = boardSignalMacro(entry.owner);
      } catch {
        issues.push({ line: entry.line, message: `GPIO owner "${entry.owner}" does not produce a valid board signal name.` });
        continue;
      }
      const signal = boardSignals.get(`${ownerMacro}:${entry.pinId}`);
      entry.activeLevel = signal?.activeLevel ?? (entry.gpioMode === "output-high" ? "high" : "low");
      continue;
    }
    if (entry.mux === undefined) continue;

    const selectedFunction = pin.functions.find(option => option.mux === entry.mux);
    if (!selectedFunction) {
      issues.push({ line: entry.line, message: `${entry.pinId} does not support FUNC${entry.mux}.` });
      continue;
    }
    entry.signal = selectedFunction.signal;
    if (definition.signals[entry.owner] && entry.owner !== selectedFunction.signal) {
      issues.push({
        line: entry.line,
        message: `${entry.owner} on ${entry.pinId}/FUNC${entry.mux} selects ${selectedFunction.signal}.`,
      });
    }
  }

  return { filePath, entries, issues };
}

export async function loadBoardPinmuxFile(filePath: string, definition: PinmuxDefinition): Promise<BoardPinmuxDocument> {
  const source = await fs.promises.readFile(filePath, "utf-8");
  const boardPinsPath = path.join(path.dirname(filePath), "include", "board_pins.h");
  let boardPinsSource: string | undefined;
  try {
    boardPinsSource = await fs.promises.readFile(boardPinsPath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return parseBoardPinmux(source, filePath, definition, boardPinsSource);
}
