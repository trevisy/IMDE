import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { KconfigParser } from "../src/menuconfig/KconfigParser";
import { VisibilityManager } from "../src/menuconfig/VisibilityManager";
import { Menu } from "../src/menuconfig/Menu";
import { KconfigWriter } from "../src/menuconfig/KconfigWriter";
import { normalizeConfigStringValue, normalizeHexValue, normalizeIntValue, parseKconfigNumber } from "../src/menuconfig/MenuValueUtils";
import { KconfigSessionCache } from "../src/menuconfig/KconfigSessionCache";

let passed = 0;
let failed = 0;

function check(cond: boolean, msg: string) {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error("  FAIL:", msg);
  }
}

function flattenMenus(menus: Menu[]): Menu[] {
  const result: Menu[] = [];
  for (const menu of menus) {
    result.push(menu);
    if (menu.children && menu.children.length > 0) {
      result.push(...flattenMenus(menu.children));
    }
  }
  return result;
}

function findMenu(menus: Menu[], name: string): Menu {
  const found = flattenMenus(menus).find(menu => menu.name === name);
  assert.ok(found, `Missing menu ${name}`);
  return found!;
}

async function withTempKconfig(content: string, run: (dir: string, main: string) => Promise<void>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "imde-kconfig-"));
  const main = path.join(dir, "Kconfig");
  fs.writeFileSync(main, content, "utf-8");
  try {
    await run(dir, main);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function parseKconfig(dir: string, main: string): Promise<Menu[]> {
  const parser = new KconfigParser({
    workspaceFolder: dir,
    mainKconfigFile: main,
  });
  return parser.parse();
}

async function testEscapedQuotePrompt() {
  await withTempKconfig(`
menu "Display"

config LCD_PANEL_KWH035
    bool "KWH035 3.5\\" 320x480 SLCD panel"
    default y

endmenu
`, async (dir, main) => {
    const menus = await parseKconfig(dir, main);
    const panel = findMenu(menus, "LCD_PANEL_KWH035");
    check(panel.title === 'KWH035 3.5" 320x480 SLCD panel', "escaped quote prompt is parsed as one string");
  });
}

async function testOsChoiceDefaultsAndIfSource() {
  const mainContent = `
menu "OS"

config OS_API
    bool "Build OS API"
    default y

config OS
    bool "Enable OS scheduler"
    depends on OS_API
    default y

choice
    prompt "OS backend"
    depends on OS_API
    default OS_BACKEND_FREERTOS if OS
    default OS_BACKEND_BAREMETAL if !OS

config OS_BACKEND_BAREMETAL
    bool "Baremetal"
    depends on !OS

config OS_BACKEND_FREERTOS
    bool "FreeRTOS"
    depends on OS

endchoice

if OS_API && OS_BACKEND_FREERTOS
    source "code/os/freertos/Kconfig"
endif

endmenu
`;

  await withTempKconfig(mainContent, async (dir, main) => {
    const freertosDir = path.join(dir, "code", "os", "freertos");
    fs.mkdirSync(freertosDir, { recursive: true });
    fs.writeFileSync(path.join(freertosDir, "Kconfig"), `
config FREERTOS_TICK_RATE
    int "FreeRTOS tick rate"
    default 1000
`, "utf-8");

    const menus = await parseKconfig(dir, main);
    const visibility = new VisibilityManager();
    visibility.initialize(menus);

    const osApi = findMenu(menus, "OS_API");
    const os = findMenu(menus, "OS");
    const choice = flattenMenus(menus).find(menu => menu.type === "choice" && menu.title === "OS backend");
    assert.ok(choice, "Missing OS backend choice");

    const baremetal = findMenu(menus, "OS_BACKEND_BAREMETAL");
    const freertos = findMenu(menus, "OS_BACKEND_FREERTOS");
    const freertosTick = findMenu(menus, "FREERTOS_TICK_RATE");

    check(choice!.value === "OS_BACKEND_FREERTOS", "OS=true selects FreeRTOS default");
    check(freertos.value === true, "FreeRTOS option is selected when OS=true");
    check(baremetal.value === false, "Baremetal option is not selected when OS=true");
    check(freertos.directDepExpr === "OS", "helper direct dependency shows only symbol-local depends on");
    check((freertos.effectiveDepExpr || "").includes("OS_API") && (freertos.effectiveDepExpr || "").includes("OS"), "helper effective dependency includes inherited choice dependencies");
    check(!freertosTick.directDepExpr, "helper direct dependency stays empty for sourced symbol without direct depends on");
    check((freertosTick.effectiveDepExpr || "").includes("OS_API") && (freertosTick.effectiveDepExpr || "").includes("OS_BACKEND_FREERTOS"), "helper effective dependency includes if-scoped source condition");
    check(freertosTick.dependsOn.includes("OS_API") && freertosTick.dependsOn.includes("OS_BACKEND_FREERTOS"), "if-scoped source inherits OS backend dependency");
    check(freertosTick.isVisible === true, "sourced FreeRTOS config is visible when FreeRTOS backend is selected");

    visibility.updateValue(os.id, false);
    check(choice!.value === "OS_BACKEND_BAREMETAL", "OS=false reselects Baremetal default");
    check(baremetal.value === true, "Baremetal option is selected when OS=false");
    check(freertos.value === false, "FreeRTOS option is cleared when OS=false");
    check(freertosTick.isVisible === false, "sourced FreeRTOS config hides when FreeRTOS backend is not selected");

    visibility.updateValue(osApi.id, false);
    check(choice!.value === null, "OS_API=false clears hidden OS backend choice");
    check(baremetal.value === false, "hidden Baremetal choice option is cleared");
    check(freertos.value === false, "hidden FreeRTOS choice option is cleared");
  });
}

async function testChoiceOptionsFromSources() {
  await withTempKconfig(`
choice
    prompt "G32S10 board"
    default BOARD_FPGA_IMAGE1

source "code/bsp/g32s10/fpga_image1/Kconfig"
source "code/bsp/g32s10/fpga_image2/Kconfig"

endchoice
`, async (dir, main) => {
    const boardRoot = path.join(dir, "code", "bsp", "g32s10");
    fs.mkdirSync(path.join(boardRoot, "fpga_image1"), { recursive: true });
    fs.mkdirSync(path.join(boardRoot, "fpga_image2"), { recursive: true });
    fs.writeFileSync(path.join(boardRoot, "fpga_image1", "Kconfig"), `
config BOARD_FPGA_IMAGE1
    bool "FPGA IMAGE1 board"
`, "utf-8");
    fs.writeFileSync(path.join(boardRoot, "fpga_image2", "Kconfig"), `
config BOARD_FPGA_IMAGE2
    bool "FPGA IMAGE2 board"
`, "utf-8");

    const menus = await parseKconfig(dir, main);
    const visibility = new VisibilityManager();
    visibility.initialize(menus);
    const choice = flattenMenus(menus).find(menu => menu.type === "choice" && menu.title === "G32S10 board");
    assert.ok(choice, "Missing sourced board choice");

    check(choice!.children.length === 2, "choice includes options declared by sourced Kconfig files");
    check(choice!.children[0].name === "BOARD_FPGA_IMAGE1", "first sourced board option keeps its config name");
    check(choice!.children[1].title === "FPGA IMAGE2 board", "second sourced board option keeps its prompt");
    check(choice!.value === "BOARD_FPGA_IMAGE1", "sourced board choice applies its default");
  });
}

async function testConditionalDuplicateSymbolDefinitions() {
  await withTempKconfig(`
menu "SoC"

choice
    prompt "SoC series"
    default SOC_A

config SOC_A
    bool "SoC A"

config SOC_B
    bool "SoC B"

endchoice

if SOC_A
    source "soc-a/Kconfig"
endif

if SOC_B
    source "soc-b/Kconfig"
endif

config CONSUMER
    bool "Consumer"
    depends on BUILD_CORE_V1
    default y

endmenu
`, async (dir, main) => {
    fs.mkdirSync(path.join(dir, "soc-a"), { recursive: true });
    fs.mkdirSync(path.join(dir, "soc-b"), { recursive: true });
    fs.writeFileSync(path.join(dir, "soc-a", "Kconfig"), `
config BUILD_CORE_V1
    bool "Build V1 firmware"
    default y
`, "utf-8");
    fs.writeFileSync(path.join(dir, "soc-b", "Kconfig"), `
config BUILD_CORE_V1
    bool "Build V1 firmware"
    default y
`, "utf-8");

    const menus = await parseKconfig(dir, main);
    const visibility = new VisibilityManager();
    visibility.initialize(menus);

    const definitions = flattenMenus(menus).filter(menu => menu.name === "BUILD_CORE_V1");
    const activeDefinition = definitions.find(menu => menu.dependsOn.includes("SOC_A"));
    const consumer = findMenu(menus, "CONSUMER");

    check(definitions.length === 2, "conditional duplicate symbol definitions remain represented in the menu tree");
    check(visibility.getContext().BUILD_CORE_V1 === true, "active duplicate definition supplies the shared symbol value");
    check(consumer.isVisible === true, "consumer remains visible when the active duplicate definition is enabled");

    assert.ok(activeDefinition, "Missing active BUILD_CORE_V1 definition");
    visibility.updateValue(activeDefinition!.id, false);
    check(visibility.getContext().BUILD_CORE_V1 === false, "disabling the active duplicate definition updates the shared symbol value");
    check(consumer.isVisible === false, "consumer hides when the active duplicate definition is disabled");
  });
}

async function testLegacySessionCacheIsRejected() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "imde-kconfig-cache-"));
  const main = path.join(dir, "Kconfig");
  fs.writeFileSync(main, "mainmenu \"Cache test\"\n", "utf-8");
  try {
    const cacheKey = KconfigSessionCache.buildCacheKey(main);
    const cacheDir = path.join(dir, ".kconfig-cache");
    fs.mkdirSync(cacheDir, { recursive: true });
    const stat = fs.statSync(main);
    fs.writeFileSync(path.join(cacheDir, `${cacheKey}.json`), JSON.stringify({
      version: 4,
      cacheKey,
      createdAt: Date.now(),
      files: [{ path: main, size: stat.size, mtimeMs: stat.mtimeMs }],
      menus: [{ id: "legacy", title: "Legacy", children: [] }],
    }), "utf-8");

    const cachedMenus = await new KconfigSessionCache(dir).load(cacheKey);
    check(cachedMenus === null, "legacy Kconfig session cache is rejected after parser changes");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function testNumericDefaultsAndRanges() {
  await withTempKconfig(`
menu "Numbers"

config INT_HEX_DEFAULT
    int "Int with hex default"
    default 0x5c00
    range 0x100 0xffff

config HEX_WITH_RANGE
    hex "Hex with range"
    default 0x20
    range 0x10 0x30

endmenu
`, async (dir, main) => {
    const menus = await parseKconfig(dir, main);
    const visibility = new VisibilityManager();
    visibility.initialize(menus);

    const intHexDefault = findMenu(menus, "INT_HEX_DEFAULT");
    const hexWithRange = findMenu(menus, "HEX_WITH_RANGE");

    check(intHexDefault.value === 0x5c00, "int default accepts hex literal");
    check(intHexDefault.range[0] === 0x100 && intHexDefault.range[1] === 0xffff, "int range accepts hex literals");
    check(hexWithRange.value === "0x20", "hex default preserves hex value");
    check(hexWithRange.range[0] === 0x10 && hexWithRange.range[1] === 0x30, "hex range accepts hex literals");
  });
}

function testWriterNormalization() {
  const writer = new KconfigWriter(new Map());

  const configText = writer.generateConfigLines([
    {
      id: "menu-1",
      name: "ROOT",
      title: "Root",
      type: "menu" as any,
      value: null,
      help: "",
      range: [],
      isVisible: true,
      isCollapsed: false,
      isMenuconfig: false,
      hasPrompt: true,
      dependsOn: "",
      select: [],
      selectedBy: [],
      children: [
        {
          id: "menu-2",
          name: "INT_HEX_INPUT",
          title: "Int hex input",
          type: "int" as any,
          value: "0x5c00",
          help: "",
          range: [0x100, 0xffff],
          isVisible: true,
          isCollapsed: false,
          isMenuconfig: false,
          hasPrompt: true,
          dependsOn: "",
          select: [],
          selectedBy: [],
          children: [],
        },
        {
          id: "menu-3",
          name: "HEX_CLAMPED",
          title: "Hex clamped",
          type: "hex" as any,
          value: "0x100",
          help: "",
          range: [0x10, 0x30],
          isVisible: true,
          isCollapsed: false,
          isMenuconfig: false,
          hasPrompt: true,
          dependsOn: "",
          select: [],
          selectedBy: [],
          children: [],
        },
        {
          id: "menu-4",
          name: "STRING_LITERAL_DOLLAR",
          title: "String literal dollar",
          type: "string" as any,
          value: "$SHOULD_NOT_EXPAND",
          help: "",
          range: [],
          isVisible: true,
          isCollapsed: false,
          isMenuconfig: false,
          hasPrompt: true,
          dependsOn: "",
          select: [],
          selectedBy: [],
          children: [],
        },
      ],
    },
  ] as Menu[]).join("\n");

  check(configText.includes("CONFIG_INT_HEX_INPUT=23552"), "writer serializes int hex input numerically");
  check(configText.includes("CONFIG_HEX_CLAMPED=0x30"), "writer clamps hex value using hex range");
  check(configText.includes('CONFIG_STRING_LITERAL_DOLLAR="$SHOULD_NOT_EXPAND"'), "writer preserves literal dollar strings");
}

function testValueUtilities() {
  check(parseKconfigNumber("0x20") === 32, "parseKconfigNumber handles hex");
  check(parseKconfigNumber("0b1010") === 10, "parseKconfigNumber handles binary");
  check(parseKconfigNumber("-0o10") === -8, "parseKconfigNumber handles signed octal");
  check(normalizeIntValue("0x100", [0, 10]) === 10, "normalizeIntValue clamps parsed hex");
  check(normalizeHexValue("64", [0x10, 0x80]) === "0x64", "normalizeHexValue treats bare hex input as hex");
  check(normalizeConfigStringValue('"3.5\\\\\\" panel"') === '3.5\\" panel', "normalizeConfigStringValue unescapes config strings conservatively");
  check(normalizeConfigStringValue('"literal $FOO"') === "literal $FOO", "normalizeConfigStringValue preserves literal dollar");
}

(async () => {
  console.log("\n=== Kconfig Parser ===");
  await testEscapedQuotePrompt();
  await testOsChoiceDefaultsAndIfSource();
  await testChoiceOptionsFromSources();
  await testConditionalDuplicateSymbolDefinitions();
  await testLegacySessionCacheIsRejected();
  await testNumericDefaultsAndRanges();
  testWriterNormalization();
  testValueUtilities();

  console.log("\n" + (failed === 0 ? "OK" : "FAIL") + ` Passed: ${passed}  Failed: ${failed}`);
  if (failed > 0) {
    process.exit(1);
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
