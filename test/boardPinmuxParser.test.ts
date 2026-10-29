import * as path from "path";
import { parseBoardPinmux } from "../src/pinmux/boardParser";
import { PinmuxDefinition } from "../src/pinmux/types";

let passed = 0;
let failed = 0;

function check(condition: boolean, message: string): void {
  if (condition) {
    passed++;
  } else {
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
    CAN0_TX: { direction: "output", defaultValue: 1 },
    OTHER: { direction: "output", defaultValue: 0 },
  },
  pins: [
    {
      id: "PC04",
      powerDomain: "VDD",
      pad: "CAN0_TX_PC04",
      default: { mode: "input", pull: "none", driveStrength_mA: 10 },
      functions: [{ mux: 2, signal: "OTHER" }, { mux: 3, signal: "CAN0_TX" }],
    },
    {
      id: "PA01",
      powerDomain: "VDD",
      pad: "GPIO_PA01",
      default: { mode: "input", pull: "none", driveStrength_mA: 10 },
      functions: [],
    },
  ],
  peripheralGroups: [],
};

function testParsesFunctionAndGpioEntries(): void {
  const source = `
/* BSP_GPIO_PINMUX("IGNORED", GPIOA, 0U, HAL_GPIO_FUNCTION_INPUT,
                    HAL_GPIO_PULL_NONE, HAL_GPIO_SPEED_LOW,
                    HAL_GPIO_DRIVE_STRENGTH_10MA, false), */
BSP_GPIO_PINMUX("CAN0_TX", GPIOC, 4U, HAL_GPIO_FUNCTION_3,
                HAL_GPIO_PULL_UP, HAL_GPIO_SPEED_HIGH,
                HAL_GPIO_DRIVE_STRENGTH_20MA, true),
BSP_GPIO_PINMUX("LED", GPIOA, 1U, HAL_GPIO_FUNCTION_OUTPUT_HIGH,
                HAL_GPIO_PULL_NONE, HAL_GPIO_SPEED_LOW,
                HAL_GPIO_DRIVE_STRENGTH_10MA, false),
`;
  const boardPins = `#define BOARD_LED GPIO_SIGNAL(GPIOA, GPIO_PIN_1, false)\n`;
  const result = parseBoardPinmux(source, path.join("board", "board_pinmux.c"), definition, boardPins);
  check(result.entries.length === 2, "function and GPIO entries are parsed while comments are ignored");
  check(result.entries[0]?.pinId === "PC04" && result.entries[0]?.signal === "CAN0_TX", "function entry resolves through .impx");
  check(result.entries[0]?.pull === "up" && result.entries[0]?.driveStrength_mA === 20 && result.entries[0]?.schmitt, "electrical settings are parsed");
  check(result.entries[1]?.gpioMode === "output-high", "GPIO output mode is parsed");
  check(result.entries[1]?.activeLevel === "low", "GPIO active level is loaded from board_pins.h");
  check(result.issues.length === 0, "valid entries have no issues");
}

function testParsesImGpioFormat(): void {
  const source = `
IM_GPIO_PINMUX_CONFIG("CAN0_TX", IM_GPIO_PORT_C, 4U, IM_GPIO_FUNCTION_3,
                      IM_GPIO_PULL_UP, IM_GPIO_SLEW_HIGH,
                      IM_GPIO_DRIVE_STRENGTH_20MA, true),
IM_GPIO_PINMUX_CONFIG("LED", IM_GPIO_PORT_A, 1U, IM_GPIO_FUNCTION_OUTPUT_HIGH,
                      IM_GPIO_PULL_NONE, IM_GPIO_SLEW_LOW,
                      IM_GPIO_DRIVE_STRENGTH_10MA, false),
`;
  const boardPins = `#define BOARD_LED IM_GPIO_SIGNAL(IM_GPIO_PORT_A, 1U, true)\n`;
  const result = parseBoardPinmux(source, "board_pinmux.c", definition, boardPins);
  check(result.entries.length === 2, "new function and GPIO entries are parsed");
  check(result.entries[0]?.signal === "CAN0_TX" && result.entries[0]?.mux === 3, "new FUNC enum is parsed");
  check(result.entries[1]?.gpioMode === "output-high", "new GPIO mode is parsed");
  check(result.entries[1]?.activeLevel === "high", "new board pin signal is parsed");
  check(result.issues.length === 0, "new format entries have no issues");
}

function testReportsMuxMismatchAndDuplicatePin(): void {
  const source = `
BSP_GPIO_PINMUX("CAN0_TX", GPIOC, 4U, HAL_GPIO_FUNCTION_2,
                HAL_GPIO_PULL_NONE, HAL_GPIO_SPEED_HIGH,
                HAL_GPIO_DRIVE_STRENGTH_10MA, false),
BSP_GPIO_PINMUX("ALIAS", GPIOC, 4U, HAL_GPIO_FUNCTION_3,
                HAL_GPIO_PULL_NONE, HAL_GPIO_SPEED_HIGH,
                HAL_GPIO_DRIVE_STRENGTH_10MA, false),
  `;
  const result = parseBoardPinmux(source, "board_pinmux.c", definition);
  check(result.issues.some(issue => issue.message.includes("selects OTHER")), "owner and FUNC mismatch is reported");
  check(result.issues.some(issue => issue.message.includes("already configured")), "duplicate pin is reported");
}

function testReportsUnsupportedArguments(): void {
  const source = `BSP_GPIO_PINMUX("LED", GPIOA, 1U, HAL_GPIO_FUNCTION_ANALOG,
    HAL_GPIO_PULL_NONE, HAL_GPIO_SPEED_LOW, HAL_GPIO_DRIVE_STRENGTH_10MA, false),`;
  const result = parseBoardPinmux(source, "board_pinmux.c", definition);
  check(result.entries.length === 0 && result.issues.length === 1, "unsupported macro arguments are rejected");
}

function testReportsInvalidGpioOwner(): void {
  const source = `BSP_GPIO_PINMUX("!!!", GPIOA, 1U, HAL_GPIO_FUNCTION_OUTPUT_HIGH,
    HAL_GPIO_PULL_NONE, HAL_GPIO_SPEED_LOW, HAL_GPIO_DRIVE_STRENGTH_10MA, false),`;
  const result = parseBoardPinmux(source, "board_pinmux.c", definition);
  check(result.entries.length === 1, "invalid GPIO owner does not discard the parsed pin");
  check(result.issues.some(issue => issue.message.includes("does not produce a valid board signal name")), "invalid GPIO owner is reported as a parse issue");
}

console.log("\n=== Board Pinmux Parser ===");
testParsesFunctionAndGpioEntries();
testParsesImGpioFormat();
testReportsMuxMismatchAndDuplicatePin();
testReportsUnsupportedArguments();
testReportsInvalidGpioOwner();
console.log("\n" + (failed === 0 ? "OK" : "FAIL") + ` Passed: ${passed}  Failed: ${failed}`);
if (failed > 0) process.exit(1);
