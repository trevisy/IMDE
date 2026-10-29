import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { parseBoardPinmuxIdentity, resolveBoardPinlist } from "../src/pinmux/boardIdentity";
import { generateBoardPinmuxSource } from "../src/pinmux/boardGenerator";
import { PinmuxDefinition } from "../src/pinmux/types";

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "imde-identity-"));
  try {
    const definition: PinmuxDefinition = {
      format: "impx", version: 1,
      chip: { id: "g32s103", name: "G32S103" },
      package: { id: "qfn68", name: "QFN-68", pinCount: 68 },
      pins: [], signals: {}, peripheralGroups: [],
    };
    const board = path.join(root, "board_pinmux.c");
    const first = path.join(root, "arbitrary-name.impx");
    const other = path.join(root, "other.impx");
    fs.writeFileSync(first, JSON.stringify(definition));
    fs.writeFileSync(other, JSON.stringify({ ...definition, chip: { id: "g32s107", name: "G32S107" } }));
    const generated = generateBoardPinmuxSource(definition, "g32s10", "board", [], { mode: "persisted", allowEmpty: true });
    fs.writeFileSync(board, generated);
    assert.deepStrictEqual(parseBoardPinmuxIdentity(generated), { chipId: "g32s103", packageId: "qfn68" });
    assert.strictEqual(await resolveBoardPinlist(board, [other, first]), first);
    await assert.rejects(resolveBoardPinlist(board, [other]), /found 0/);
    await assert.rejects(resolveBoardPinlist(board, [first, first]), /found 2/);
    assert.throws(() => parseBoardPinmuxIdentity('#define BSP_PINMUX_CHIP "g32s103"'), /both/);
    assert.strictEqual(parseBoardPinmuxIdentity('/* #define BSP_PINMUX_CHIP "sample" */'), undefined);
    fs.writeFileSync(board, "/* old board without identity */");
    assert.strictEqual(await resolveBoardPinlist(board, [first]), undefined);
    console.log("Board identity: generation, auto matching, missing/ambiguous identity and legacy fallback passed.");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
