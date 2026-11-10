import * as fs from "fs";
import { PinmuxDefinition, PinmuxFunction, PinmuxPeripheralGroup, PinmuxPin, PinmuxSignal } from "./types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`Invalid .impx field: ${field}`);
  return value;
}

function isSignalName(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_]*$/.test(value);
}

function isPinId(value: string): boolean {
  return /^P[A-Z][0-9]+$/.test(value);
}

function isIdentifier(value: string): boolean {
  return /^[a-z][a-z0-9-]*$/.test(value);
}

function isPeripheralName(value: string): boolean {
  return /^[A-Z][A-Z0-9]*$/.test(value);
}

function isDriveStrength(value: unknown): value is number | string {
  if (typeof value === "number") return [10, 20, 30, 40].includes(value);
  return typeof value === "string" && /^(10|20|30|40)mA$/.test(value);
}

function isMux(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 3;
}

function parseSignals(value: unknown): Record<string, PinmuxSignal> {
  if (!isRecord(value)) throw new Error("Invalid .impx field: signals");
  const signals: Record<string, PinmuxSignal> = {};
  for (const [name, signal] of Object.entries(value)) {
    if (!isSignalName(name)) throw new Error(`Invalid .impx signal name: ${name}`);
    if (!isRecord(signal)) throw new Error(`Invalid .impx signal: ${name}`);
    const direction = signal.direction;
    if (direction !== "input" && direction !== "output" && direction !== "bidirectional" && direction !== "unknown") {
      throw new Error(`Invalid .impx signal direction: ${name}`);
    }
    const defaultValue = signal.defaultValue;
    if (defaultValue !== null && !Number.isInteger(defaultValue)) throw new Error(`Invalid .impx signal default value: ${name}`);
    signals[name] = {
      direction,
      defaultValue: defaultValue as number | null,
      description: signal.description === undefined ? undefined : requireString(signal.description, `${name}.description`),
    };
  }
  return signals;
}

function parseFunctions(value: unknown, pinId: string): PinmuxFunction[] {
  if (!Array.isArray(value)) throw new Error(`Invalid .impx functions: ${pinId}`);
  return value.map((item, index) => {
    if (!isRecord(item) || !Number.isInteger(item.mux) || (item.mux as number) < 0 || (item.mux as number) > 3 || typeof item.signal !== "string" || !isSignalName(item.signal)) {
      throw new Error(`Invalid .impx function: ${pinId}[${index}]`);
    }
    return { mux: item.mux as number, signal: item.signal };
  });
}

function parsePins(value: unknown): PinmuxPin[] {
  if (!Array.isArray(value)) throw new Error("Invalid .impx field: pins");
  const pinIds = new Set<string>();
  return value.map((item, index) => {
    if (!isRecord(item) || !isRecord(item.default)) throw new Error(`Invalid .impx pin: ${index}`);
    const mode = item.default.mode;
    const pull = item.default.pull;
    if ((mode !== "input" && mode !== "output" && mode !== "alternate") || (pull !== "none" && pull !== "up" && pull !== "down")) {
      throw new Error(`Invalid .impx default configuration: ${index}`);
    }
    const pinId = requireString(item.id, `pins[${index}].id`);
    if (!isPinId(pinId)) throw new Error(`Invalid .impx pin id: ${pinId}`);
    if (pinIds.has(pinId)) throw new Error(`Duplicate .impx pin id: ${pinId}`);
    pinIds.add(pinId);
    const driveStrength_mA = item.default.driveStrength_mA;
    if (!isDriveStrength(driveStrength_mA)) throw new Error(`Invalid .impx drive strength: ${pinId}`);
    const mux = item.default.mux;
    if (mux !== undefined && !isMux(mux)) {
      throw new Error(`Invalid .impx default mux: ${pinId}`);
    }
    if (mode === "alternate" && mux === undefined) {
      throw new Error(`Invalid .impx default mux: ${pinId}`);
    }
    if (mode === "output" && item.default.outputLevel !== 0 && item.default.outputLevel !== 1) {
      throw new Error(`Invalid .impx default output level: ${pinId}`);
    }
    if (mode !== "output" && item.default.outputLevel !== undefined) {
      throw new Error(`Invalid .impx default output level: ${pinId}`);
    }
    if (item.default.schmitt !== undefined && typeof item.default.schmitt !== "boolean") {
      throw new Error(`Invalid .impx default schmitt: ${pinId}`);
    }
    if (item.default.slew !== undefined && typeof item.default.slew !== "boolean") {
      throw new Error(`Invalid .impx default slew: ${pinId}`);
    }
    return {
      id: pinId,
      powerDomain: requireString(item.powerDomain, `${pinId}.powerDomain`),
      pad: requireString(item.pad, `${pinId}.pad`),
      default: {
        mode,
        pull,
        driveStrength_mA,
        mux: mux as number | undefined,
        outputLevel: item.default.outputLevel === 0 || item.default.outputLevel === 1 ? item.default.outputLevel : undefined,
        schmitt: typeof item.default.schmitt === "boolean" ? item.default.schmitt : undefined,
        slew: typeof item.default.slew === "boolean" ? item.default.slew : undefined,
      },
      functions: parseFunctions(item.functions, pinId),
    };
  });
}

function parsePeripheralGroups(value: unknown, signals: Record<string, PinmuxSignal>, pins: PinmuxPin[]): PinmuxPeripheralGroup[] {
  if (!Array.isArray(value)) throw new Error("Invalid .impx field: peripheralGroups");
  const pinsById = new Map(pins.map(pin => [pin.id, pin]));
  const groupIds = new Set<string>();
  return value.map((item, index) => {
    if (!isRecord(item) || !Array.isArray(item.assignments)) throw new Error(`Invalid .impx peripheral group: ${index}`);
    const id = requireString(item.id, `peripheralGroups[${index}].id`);
    if (!isIdentifier(id)) throw new Error(`Invalid .impx peripheral group id: ${id}`);
    if (groupIds.has(id)) throw new Error(`Duplicate .impx peripheral group: ${id}`);
    groupIds.add(id);
    const peripheral = requireString(item.peripheral, `${id}.peripheral`);
    if (!isPeripheralName(peripheral)) throw new Error(`Invalid .impx peripheral name: ${peripheral}`);
    const label = requireString(item.label, `${id}.label`);
    const assignedSignals = new Set<string>();
    const assignedPins = new Set<string>();
    const assignments = item.assignments.map((assignment, assignmentIndex) => {
      if (!isRecord(assignment) || !isMux(assignment.mux)) throw new Error(`Invalid .impx group assignment: ${id}[${assignmentIndex}]`);
      const signal = requireString(assignment.signal, `${id}[${assignmentIndex}].signal`);
      if (!isSignalName(signal)) throw new Error(`Invalid .impx signal name: ${signal}`);
      const pinId = requireString(assignment.pin, `${id}[${assignmentIndex}].pin`);
      if (!isPinId(pinId)) throw new Error(`Invalid .impx pin id: ${pinId}`);
      const pin = pinsById.get(pinId);
      if (!signals[signal] || !pin || !pin.functions.some(functionOption => functionOption.signal === signal && functionOption.mux === assignment.mux)) {
        throw new Error(`Invalid .impx group mapping: ${id} ${signal} -> ${pinId}/FUNC${assignment.mux}`);
      }
      if (assignedSignals.has(signal) || assignedPins.has(pinId)) throw new Error(`Duplicate .impx group assignment in ${id}`);
      assignedSignals.add(signal);
      assignedPins.add(pinId);
      return { signal, pin: pinId, mux: assignment.mux as number };
    });
    if (assignments.length === 0) throw new Error(`Empty .impx peripheral group: ${id}`);
    return { id, peripheral, label, assignments };
  });
}

export async function loadPinmuxFile(filePath: string): Promise<{ definition: PinmuxDefinition; filePath: string }> {
  let document: unknown;
  try {
    document = JSON.parse(await fs.promises.readFile(filePath, "utf-8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to load ${filePath}: ${message}`);
  }
  if (!isRecord(document) || document.format !== "impx" || document.version !== 1 || !isRecord(document.chip) || !isRecord(document.package)) {
    throw new Error("Unsupported .impx document.");
  }
  const chipId = requireString(document.chip.id, "chip.id");
  const packageId = requireString(document.package.id, "package.id");
  if (!isIdentifier(chipId) || !isIdentifier(packageId)) throw new Error("Invalid .impx chip or package id.");
  const chipName = requireString(document.chip.name, "chip.name");
  const packageName = requireString(document.package.name, "package.name");
  const packagePinCount = document.package.pinCount;
  if (!Number.isInteger(packagePinCount) || (packagePinCount as number) < 1) throw new Error("Invalid .impx package pin count.");
  const pinCount = packagePinCount as number;
  const signals = parseSignals(document.signals);
  const pins = parsePins(document.pins);
  if (pins.length === 0 || pins.length > pinCount) throw new Error("Invalid .impx pins count for package.");
  for (const pin of pins) {
    for (const fn of pin.functions) {
      if (!signals[fn.signal]) throw new Error(`Unknown .impx signal ${fn.signal} on ${pin.id}.`);
    }
  }
  const peripheralGroups = parsePeripheralGroups(document.peripheralGroups, signals, pins);
  if (document.source !== undefined && !isRecord(document.source)) throw new Error("Invalid .impx source.");
  return {
    filePath,
    definition: {
      format: "impx",
      version: 1,
      chip: { id: chipId, name: chipName },
      package: { id: packageId, name: packageName, pinCount },
      ...(isRecord(document.source) ? { source: {
        file: requireString(document.source.file, "source.file"),
        revision: requireString(document.source.revision, "source.revision"),
        date: requireString(document.source.date, "source.date"),
        sheets: Array.isArray(document.source.sheets) && document.source.sheets.every((sheet): sheet is string => typeof sheet === "string")
          ? document.source.sheets
          : (() => { throw new Error("Invalid .impx source sheets."); })(),
      } } : {}),
      signals,
      pins,
      peripheralGroups,
    },
  };
}
