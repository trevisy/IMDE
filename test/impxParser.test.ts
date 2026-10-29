import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { loadPinmuxFile } from "../src/pinmux/parser";

async function main(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "imde-impx-parser-"));
  const file = path.join(root, "test.impx");
  const document = {
    format: "impx",
    version: 1,
    chip: { id: "test", name: "Test" },
    package: { id: "qfn", name: "QFN", pinCount: 2 },
    signals: { SIG: { direction: "input", defaultValue: 0 } },
    pins: [{
      id: "PA00",
      powerDomain: "VDD",
      pad: "SIG_PA00",
      default: { mode: "input", pull: "none", driveStrength_mA: "10mA" },
      functions: [{ mux: 3, signal: "SIG" }],
    }],
    peripheralGroups: [],
  };
  const writeAndLoad = async (value: unknown) => {
    fs.writeFileSync(file, JSON.stringify(value));
    return loadPinmuxFile(file);
  };

  try {
    const loaded = await writeAndLoad(document);
    assert.strictEqual(loaded.definition.pins[0].default.driveStrength_mA, "10mA");

    const invalidDrive = structuredClone(document);
    invalidDrive.pins[0].default.driveStrength_mA = "10 mA";
    await assert.rejects(writeAndLoad(invalidDrive), /drive strength/);

    const invalidMux = structuredClone(document);
    invalidMux.pins[0].functions[0].mux = 4;
    await assert.rejects(writeAndLoad(invalidMux), /function/);

    const missingAlternateMux = structuredClone(document);
    missingAlternateMux.pins[0].default.mode = "alternate";
    await assert.rejects(writeAndLoad(missingAlternateMux), /default mux/);

    const invalidPinId = structuredClone(document);
    invalidPinId.pins[0].id = "PAA00";
    await assert.rejects(writeAndLoad(invalidPinId), /pin id/);

    console.log("IMPX parser: valid units, drive validation, mux range, conditional defaults and pin IDs passed.");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
