import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { discoverPinmuxTargets } from "../src/pinmux/discovery";

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

function writeFile(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "", "utf-8");
}

async function testDiscoversChipsBoardsAndPinlists(): Promise<void> {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "imde-pinmux-discovery-"));
  try {
    writeFile(path.join(projectDir, "code", "bsp", "common", "bsp_gpio.c"));
    writeFile(path.join(projectDir, "code", "bsp", "g32s10", "include", "not-a-board.h"));
    writeFile(path.join(projectDir, "code", "bsp", "g32s10", "g32s10_fpga", "board_pinmux.c"));
    writeFile(path.join(projectDir, "code", "bsp", "g32s10", "pd_lock", "board_pinmux.c"));
    writeFile(path.join(projectDir, "tools", "imde", "pinmux", "g32s10", "g32s10-qfn148.impx"));

    const chips = await discoverPinmuxTargets(projectDir);
    check(chips.length === 1, "common and include directories are not discovered as chips or boards");
    check(chips[0]?.id === "g32s10", "g32s10 chip is discovered");
    check(chips[0]?.boards.map(board => board.id).join(",") === "g32s10_fpga,pd_lock", "boards are discovered and naturally sorted");
    check(chips[0]?.pinlistFiles.length === 1, "chip .impx files are discovered");
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
}

async function testMissingBspDirectoryIsEmpty(): Promise<void> {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "imde-pinmux-discovery-empty-"));
  try {
    check((await discoverPinmuxTargets(projectDir)).length === 0, "missing BSP directory returns no targets");
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
}

async function testDiscoversChipWithoutBoards(): Promise<void> {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "imde-pinmux-discovery-blank-"));
  try {
    writeFile(path.join(projectDir, "code", "bsp", "g32s20", "placeholder.txt"));
    writeFile(path.join(projectDir, "tools", "imde", "pinmux", "g32s20", "g32s20-qfn100.impx"));

    const chips = await discoverPinmuxTargets(projectDir);
    check(chips.length === 1 && chips[0]?.id === "g32s20", "chip with only a pinlist is available for blank BSP creation");
    check(chips[0]?.boards.length === 0 && chips[0]?.pinlistFiles.length === 1, "pinlist-only chip has no boards but keeps its package list");
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
}

async function testDiscoversTestBspBoards(): Promise<void> {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "imde-pinmux-discovery-test-bsp-"));
  try {
    writeFile(path.join(projectDir, "code", "bsp", "g32s10", "project_board", "board_pinmux.c"));
    writeFile(path.join(projectDir, "test", "bsp", "g32s10", "fpga_image1", "board_pinmux.c"));
    writeFile(path.join(projectDir, "tools", "imde", "pinmux", "g32s10", "g32s10-qfn148.impx"));

    const chips = await discoverPinmuxTargets(projectDir);
    check(chips.length === 1, "project and test BSP roots are grouped under one chip");
    check(chips[0]?.boards.map(board => board.id).join(",") === "fpga_image1,project_board", "test BSP boards are included");
    const testBoard = chips[0]?.boards.find(board => board.id === "fpga_image1");
    check(testBoard?.source === "test" && testBoard.chipDirectory.endsWith(path.join("test", "bsp", "g32s10")), "test BSP keeps its source and chip directory");
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  console.log("\n=== Pinmux Discovery ===");
  await testDiscoversChipsBoardsAndPinlists();
  await testMissingBspDirectoryIsEmpty();
  await testDiscoversChipWithoutBoards();
  await testDiscoversTestBspBoards();
  console.log("\n" + (failed === 0 ? "OK" : "FAIL") + ` Passed: ${passed}  Failed: ${failed}`);
  if (failed > 0) process.exit(1);
}

void main();
