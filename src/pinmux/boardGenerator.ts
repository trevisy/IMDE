import { PinmuxDefinition } from "./types";

export interface BoardPinmuxConfiguration {
  owner?: string;
  pinId: string;
  kind: "function" | "gpio";
  mux?: number;
  gpioMode?: "input" | "output-low" | "output-high";
  activeLevel?: "low" | "high";
  pull: "none" | "up" | "down";
  speed: "low" | "high";
  driveStrength_mA: number | string;
  schmitt: boolean;
}

export interface BoardPinmuxGenerationOptions {
  mode?: "preview" | "persisted";
  allowEmpty?: boolean;
}

function requirePin(definition: PinmuxDefinition, pinId: string) {
  const pin = definition.pins.find(candidate => candidate.id === pinId);
  if (!pin) throw new Error(`${pinId} is not present in ${definition.package.id}.`);
  return pin;
}

function pinLocation(pinId: string): { port: string; index: number } {
  const match = /^P([A-Z])(\d+)$/.exec(pinId);
  if (!match) throw new Error(`Invalid logical pin id: ${pinId}.`);
  return { port: match[1], index: Number(match[2]) };
}

export function boardSignalMacro(owner: string): string {
  const normalized = owner.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (!normalized) throw new Error("GPIO owner does not produce a valid board signal name.");
  return normalized.startsWith("BOARD_") ? normalized : `BOARD_${normalized}`;
}

function activeLevel(configuration: BoardPinmuxConfiguration): "low" | "high" {
  if (configuration.activeLevel === "low" || configuration.activeLevel === "high") {
    return configuration.activeLevel;
  }
  return configuration.gpioMode === "output-high" ? "high" : "low";
}

function functionMode(configuration: BoardPinmuxConfiguration, signal: string): string {
  if (!Number.isInteger(configuration.mux) || configuration.mux! < 0 || configuration.mux! > 3) {
    throw new Error(`${signal} has an invalid FUNC value.`);
  }
  return `IM_GPIO_FUNCTION_${configuration.mux}`;
}

function gpioMode(configuration: BoardPinmuxConfiguration): string {
  switch (configuration.gpioMode) {
    case "input": return "IM_GPIO_FUNCTION_INPUT";
    case "output-low": return "IM_GPIO_FUNCTION_OUTPUT_LOW";
    case "output-high": return "IM_GPIO_FUNCTION_OUTPUT_HIGH";
    default: throw new Error("GPIO configuration is missing a mode.");
  }
}

function driveStrength(value: number | string): string {
  const normalized = typeof value === "string" ? value.trim() : String(value);
  const match = /^(\d+)(?:mA)?$/.exec(normalized);
  const milliamps = match ? Number(match[1]) : NaN;
  if (![10, 20, 30, 40].includes(milliamps)) throw new Error(`Invalid GPIO drive strength: ${value}.`);
  return `IM_GPIO_DRIVE_STRENGTH_${milliamps}MA`;
}

function macroFor(configuration: BoardPinmuxConfiguration, definition: PinmuxDefinition): string {
  if (configuration.kind !== "function" && configuration.kind !== "gpio") throw new Error("Pinmux configuration has an invalid kind.");
  if (!configuration.pinId || typeof configuration.pinId !== "string") throw new Error("Pinmux configuration is missing a pin id.");
  if (configuration.owner !== undefined && typeof configuration.owner !== "string") throw new Error(`${configuration.pinId} has an invalid owner.`);
  if (configuration.pull !== "none" && configuration.pull !== "up" && configuration.pull !== "down") throw new Error(`${configuration.pinId} has an invalid pull setting.`);
  if (configuration.speed !== "low" && configuration.speed !== "high") throw new Error(`${configuration.pinId} has an invalid speed setting.`);
  if (typeof configuration.schmitt !== "boolean") throw new Error(`${configuration.pinId} has an invalid Schmitt setting.`);
  const pin = requirePin(definition, configuration.pinId);
  const location = pinLocation(pin.id);
  const selectedFunction = configuration.kind === "function"
    ? pin.functions.find(candidate => candidate.mux === configuration.mux)
    : undefined;
  if (configuration.kind === "function" && !selectedFunction) {
    throw new Error(`${pin.id} does not support FUNC${configuration.mux}.`);
  }
  const explicitOwner = configuration.owner?.trim();
  if (configuration.kind === "gpio" && !explicitOwner) throw new Error(`${pin.id} GPIO owner is required.`);
  if (configuration.kind === "function" && explicitOwner && definition.signals[explicitOwner] && explicitOwner !== selectedFunction!.signal) {
    throw new Error(`${pin.id} owner ${explicitOwner} does not match ${selectedFunction!.signal}.`);
  }
  const owner = explicitOwner || selectedFunction!.signal;
  const ownerLiteral = JSON.stringify(owner);
  const mode = configuration.kind === "function"
    ? functionMode(configuration, selectedFunction!.signal)
    : gpioMode(configuration);
  const pull = `IM_GPIO_PULL_${configuration.pull.toUpperCase()}`;
  const speed = `IM_GPIO_SLEW_${configuration.speed.toUpperCase()}`;
  const drive = driveStrength(configuration.driveStrength_mA);
  return [
    `    IM_GPIO_PINMUX_CONFIG(${ownerLiteral},`,
    `                           IM_GPIO_PORT_${location.port},`,
    `                           ${location.index}U,`,
    `                           ${mode},`,
    `                           ${pull},`,
    `                           ${speed},`,
    `                           ${drive},`,
    `                           ${configuration.schmitt ? "true" : "false"}),`,
  ].join("\n");
}

export function generateBoardPinmuxSource(
  definition: PinmuxDefinition,
  chipId: string,
  boardId: string,
  configurations: BoardPinmuxConfiguration[],
  options: BoardPinmuxGenerationOptions = {},
): string {
  const ordered = configurations.slice().sort((left, right) => left.pinId.localeCompare(right.pinId, undefined, { numeric: true }));
  if (ordered.length === 0 && !options.allowEmpty) throw new Error("Configure at least one pin before generating the BSP.");
  const duplicatePins = new Set<string>();
  const signalPins = new Map<string, string>();
  const ownerPins = new Map<string, string>();
  for (const configuration of ordered) {
    if (duplicatePins.has(configuration.pinId)) throw new Error(`${configuration.pinId} is configured more than once.`);
    duplicatePins.add(configuration.pinId);
    let selectedFunction;
    if (configuration.kind === "function") {
      const pin = requirePin(definition, configuration.pinId);
      selectedFunction = pin.functions.find(candidate => candidate.mux === configuration.mux);
      if (!selectedFunction) throw new Error(`${pin.id} does not support FUNC${configuration.mux}.`);
      const previousPin = signalPins.get(selectedFunction.signal);
      if (previousPin) throw new Error(`${selectedFunction.signal} is assigned to both ${previousPin} and ${pin.id}.`);
      signalPins.set(selectedFunction.signal, pin.id);
    }
    const owner = configuration.owner?.trim() || selectedFunction?.signal;
    if (owner) {
      const ownerKey = boardSignalMacro(owner);
      const previousPin = ownerPins.get(ownerKey);
      if (previousPin) throw new Error(`${ownerKey} owner is assigned to both ${previousPin} and ${configuration.pinId}.`);
      ownerPins.set(ownerKey, configuration.pinId);
    }
  }
  const entries = ordered.map(configuration => macroFor(configuration, definition)).join("\n");
  const isPreview = options.mode !== "persisted";
  const ownershipNote = isPreview
    ? " * This is a preview. It has not been written to the BSP.\n"
    : " * This file is generated by IMDE Pinmux. Manual edits may be overwritten.\n";
  return `/**
 * @file board_pinmux.c
 * @brief Generated by IMDE Pinmux for ${chipId}/${boardId}.
 *
${ownershipNote.trimEnd()}
 */

#include "bsp_pinmux.h"

#include "im_gpio.h"
#include "im_utils.h"

#define BSP_PINMUX_CHIP ${JSON.stringify(definition.chip.id)}
#define BSP_PINMUX_PACKAGE ${JSON.stringify(definition.package.id)}

static const im_gpio_pinmux_config_t s_board_pinmux[] = {
${entries}
};

error_code_t bsp_pinmux_init(void)
{
    return im_gpio_apply_pinmux(s_board_pinmux,
                                IM_ARRAY_SIZE(s_board_pinmux));
}
`;
}

export function generateBoardPinsHeader(
  chipId: string,
  boardId: string,
  configurations: BoardPinmuxConfiguration[],
): string {
  const gpioConfigurations = configurations
    .filter(configuration => configuration.kind === "gpio")
    .slice()
    .sort((left, right) => left.pinId.localeCompare(right.pinId, undefined, { numeric: true }));
  const macroPins = new Set<string>();
  const entries = gpioConfigurations.map(configuration => {
    if (!configuration.owner?.trim()) throw new Error(`${configuration.pinId} GPIO owner is required.`);
    const location = pinLocation(configuration.pinId);
    const macro = boardSignalMacro(configuration.owner);
    if (macroPins.has(macro)) throw new Error(`${macro} is assigned more than once.`);
    macroPins.add(macro);
    return `#define ${macro.padEnd(24)} IM_GPIO_SIGNAL(IM_GPIO_PORT_${location.port}, ${location.index}U, ${activeLevel(configuration) === "high" ? "true" : "false"})`;
  });
  const guard = `${boardSignalMacro(boardId)}_PINS_H`;
  const body = entries.length > 0 ? entries.join("\n") : "/* No GPIO signal mappings are configured. */";
  return `/**
 * @file board_pins.h
 * @brief Generated by IMDE Pinmux for ${chipId}/${boardId}.
 *
 * These macros describe the selected board GPIO signal mappings. GPIO
 * ownership and electrical configuration are applied by board_pinmux.c.
 */
#ifndef ${guard}
#define ${guard}

#include "im_gpio.h"

${body}

#endif /* ${guard} */
`;
}
