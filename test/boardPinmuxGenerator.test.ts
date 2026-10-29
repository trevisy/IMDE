import { PinmuxDefinition } from "../src/pinmux/types";
import { generateBoardPinmuxSource, generateBoardPinsHeader } from "../src/pinmux/boardGenerator";
import { parseBoardPinmux } from "../src/pinmux/boardParser";

let passed = 0;
let failed = 0;

function check(condition: boolean, message: string): void {
  if (condition) passed++;
  else {
    failed++;
    console.error("  FAIL:", message);
  }
}

const definition: PinmuxDefinition = {
  format: "impx",
  version: 1,
  chip: { id: "test", name: "Test" },
  package: { id: "qfn", name: "QFN", pinCount: 2 },
  source: { file: "test.xlsx", revision: "1", date: "2026-01-01", sheets: [] },
  signals: {
    CAN0_TX: { direction: "output", defaultValue: 0 },
    OTHER: { direction: "output", defaultValue: 0 },
  },
  pins: [
    {
      id: "PC04",
      powerDomain: "VDD",
      pad: "CAN0_TX_PC04",
      default: { mode: "input", pull: "none", driveStrength_mA: 10 },
      functions: [{ mux: 3, signal: "CAN0_TX" }],
    },
    {
      id: "PA01",
      powerDomain: "VDD",
      pad: "CAN0_TX_PA01",
      default: { mode: "input", pull: "none", driveStrength_mA: 10 },
      functions: [{ mux: 1, signal: "CAN0_TX" }],
    },
  ],
  peripheralGroups: [],
};

const source = generateBoardPinmuxSource(definition, "test", "board", [{
  owner: "CAN0_TX",
  pinId: "PC04",
  kind: "function",
  mux: 3,
  pull: "up",
  speed: "high",
  driveStrength_mA: 20,
  schmitt: true,
}]);

console.log("\n=== Board Pinmux Generator ===");
check(source.includes("IM_GPIO_PINMUX_CONFIG(\"CAN0_TX\""), "function owner is generated");
check(source.includes("#include \"im_gpio.h\"") && source.includes("error_code_t bsp_pinmux_init(void)"), "generated source includes the IMSIS GPIO interface");
check(source.includes("static const im_gpio_pinmux_config_t s_board_pinmux[]") && source.includes("im_gpio_apply_pinmux"), "generated source applies the IMSIS GPIO configuration table with SDK static naming");
check(source.includes("return im_gpio_apply_pinmux(s_board_pinmux,\n                                IM_ARRAY_SIZE(s_board_pinmux));"), "generated pinmux call arguments are aligned");
check(source.includes("IM_GPIO_FUNCTION_3"), "FUNC value is generated");
check(source.includes("IM_GPIO_PULL_UP") && source.includes("IM_GPIO_SLEW_HIGH") && source.includes("IM_GPIO_DRIVE_STRENGTH_20MA"), "electrical settings are generated");
const suffixedDriveSource = generateBoardPinmuxSource(definition, "test", "board", [{
  owner: "CAN0_TX",
  pinId: "PC04",
  kind: "function",
  mux: 3,
  pull: "up",
  speed: "high",
  driveStrength_mA: "20mA",
  schmitt: true,
}]);
check(suffixedDriveSource.includes("IM_GPIO_DRIVE_STRENGTH_20MA"), "drive strength with mA unit suffix is generated");
check(source.includes("This is a preview"), "preview marker is generated");
const persistedSource = generateBoardPinmuxSource(definition, "test", "board", [{
  owner: "CAN0_TX",
  pinId: "PC04",
  kind: "function",
  mux: 3,
  pull: "up",
  speed: "high",
  driveStrength_mA: 20,
  schmitt: true,
}], { mode: "persisted" });
check(persistedSource.includes("Manual edits may be overwritten") && !persistedSource.includes("This is a preview"), "persisted source has the generated-file marker");
const roundtrip = parseBoardPinmux(source, "preview.c", definition);
check(roundtrip.entries.length === 1 && roundtrip.issues.length === 0, "generated preview parses without issues");
const aliasedOwnerSource = generateBoardPinmuxSource(definition, "test", "board", [{
  owner: "BOARD_CAN_TX",
  pinId: "PC04",
  kind: "function",
  mux: 3,
  pull: "none",
  speed: "high",
  driveStrength_mA: 10,
  schmitt: false,
}]);
check(aliasedOwnerSource.includes("IM_GPIO_PINMUX_CONFIG(\"BOARD_CAN_TX\""), "board-level function owner aliases are preserved");
let knownOwnerMismatchRejected = false;
try {
  generateBoardPinmuxSource(definition, "test", "board", [{
    owner: "OTHER",
    pinId: "PC04",
    kind: "function",
    mux: 3,
    pull: "none",
    speed: "high",
    driveStrength_mA: 10,
    schmitt: false,
  }]);
} catch {
  knownOwnerMismatchRejected = true;
}
check(knownOwnerMismatchRejected, "a different known signal cannot be used as the function owner");
let emptyRejected = false;
try {
  generateBoardPinmuxSource(definition, "test", "board", []);
} catch {
  emptyRejected = true;
}
check(emptyRejected, "empty pin configurations are rejected");
const emptyPersistedSource = generateBoardPinmuxSource(definition, "test", "blank", [], {
  mode: "persisted",
  allowEmpty: true,
});
check(
  emptyPersistedSource.includes("static const im_gpio_pinmux_config_t s_board_pinmux[] = {")
    && emptyPersistedSource.includes("IM_ARRAY_SIZE(s_board_pinmux)")
    && emptyPersistedSource.includes("Manual edits may be overwritten"),
  "empty persisted BSP source contains a valid empty table",
);
let gpioOwnerRejected = false;
try {
  generateBoardPinmuxSource(definition, "test", "board", [{
    pinId: "PC04",
    kind: "gpio",
    gpioMode: "output-high",
    pull: "none",
    speed: "low",
    driveStrength_mA: 10,
    schmitt: false,
  }]);
} catch {
  gpioOwnerRejected = true;
}
check(gpioOwnerRejected, "GPIO preview requires an explicit owner");
const boardPins = generateBoardPinsHeader("test", "board", [{
  owner: "TP_RST",
  pinId: "PA01",
  kind: "gpio",
  gpioMode: "output-low",
  activeLevel: "low",
  pull: "none",
  speed: "low",
  driveStrength_mA: 10,
  schmitt: false,
}, {
  owner: "CAN0_TX",
  pinId: "PC04",
  kind: "function",
  mux: 3,
  pull: "none",
  speed: "high",
  driveStrength_mA: 10,
  schmitt: false,
}]);
check(boardPins.includes("BOARD_TP_RST") && boardPins.includes("IM_GPIO_SIGNAL(IM_GPIO_PORT_A, 1U, false)"), "selected GPIO signal is generated with its active level");
check(boardPins.includes("#include \"im_gpio.h\""), "generated board pins include the IMSIS GPIO interface");
check(!boardPins.includes("BOARD_CAN0_TX"), "peripheral functions are not emitted as board GPIO signals");
const gpioRoundtripSource = generateBoardPinmuxSource(definition, "test", "board", [{
  owner: "TP_RST",
  pinId: "PA01",
  kind: "gpio",
  gpioMode: "output-high",
  activeLevel: "low",
  pull: "down",
  speed: "high",
  driveStrength_mA: 20,
  schmitt: true,
}]);
const gpioRoundtrip = parseBoardPinmux(gpioRoundtripSource, "preview.c", definition, boardPins);
check(gpioRoundtrip.entries.length === 1 && gpioRoundtrip.issues.length === 0, "new GPIO source and board pins round-trip without issues");
check(gpioRoundtrip.entries[0]?.activeLevel === "low", "new board pin signal active level survives round-trip");
let duplicateSignalRejected = false;
try {
  generateBoardPinmuxSource(definition, "test", "board", [
    {
      pinId: "PC04",
      kind: "function",
      mux: 3,
      pull: "none",
      speed: "low",
      driveStrength_mA: 10,
      schmitt: false,
    },
    {
      pinId: "PA01",
      kind: "function",
      mux: 1,
      pull: "none",
      speed: "low",
      driveStrength_mA: 10,
      schmitt: false,
    },
  ]);
} catch {
  duplicateSignalRejected = true;
}
check(duplicateSignalRejected, "one peripheral signal cannot be generated on multiple pins");
let duplicateOwnerRejected = false;
try {
  generateBoardPinmuxSource(definition, "test", "board", [
    {
      owner: "tp-rst",
      pinId: "PC04",
      kind: "gpio",
      gpioMode: "output-low",
      pull: "none",
      speed: "low",
      driveStrength_mA: 10,
      schmitt: false,
    },
    {
      owner: "BOARD_TP_RST",
      pinId: "PA01",
      kind: "gpio",
      gpioMode: "output-high",
      pull: "none",
      speed: "low",
      driveStrength_mA: 10,
      schmitt: false,
    },
  ]);
} catch {
  duplicateOwnerRejected = true;
}
check(duplicateOwnerRejected, "normalized owner names cannot be generated on multiple pins");
console.log("\n" + (failed === 0 ? "OK" : "FAIL") + ` Passed: ${passed}  Failed: ${failed}`);
if (failed > 0) process.exit(1);
