import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { extractGalaxySymbols, reindexGalaxySymbols } from "../lib/galaxy-symbols.mjs";

test("indexes native declarations, multiline signatures and global constants, not comments or locals", () => {
  const source = [
    "// native void Fake();", 'const string Label = "a;{native Fake()}";',
    "native void Register(", "  trigger t,", "  int player", ");",
    "const int AnyPlayer = -1;", "/* const int Nope = 1; */", "",
    "static bool Handler(bool testConds, bool runActions) {",
    "  const int LocalOnly = 2;", "  return true;", "}",
    "void Helper(unit[16] units);",
  ].join("\r\n");
  const result = extractGalaxySymbols(source);
  assert.deepEqual(result.map((s) => [s.name, s.kind, s.line]), [
    ["Label", "constant", 2], ["Register", "native", 3], ["AnyPlayer", "constant", 7],
    ["Handler", "function", 10], ["Helper", "function", 14],
  ]);
  assert.equal(result[0].value, '"a;{native Fake()}"');
  assert.equal(result[1].signature, "native void Register( trigger t, int player );");
  assert.deepEqual(result[1].parameters, [{ type: "trigger", name: "t" }, { type: "int", name: "player" }]);
  assert.equal(result[2].value, "-1");
  assert.equal(result[4].parameters[0].type, "unit[16]");
});

test("explicit reindex is idempotent, preserves source/Catalog, and rolls back a failed rebuild", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "coop-symbols-"));
  const file = path.join(dir, "db.sqlite");
  const db = new DatabaseSync(file);
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  db.exec(`CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT);
    CREATE TABLE galaxy_files(source_file TEXT PRIMARY KEY,contents TEXT);
    CREATE TABLE galaxy_symbols(source_file TEXT,name TEXT,kind TEXT,line INTEGER,PRIMARY KEY(source_file,name,line));
    CREATE TABLE catalog_objects(id TEXT); INSERT INTO catalog_objects VALUES ('untouched');
    INSERT INTO galaxy_files VALUES ('native.galaxy','native int GetPlayer(unit u);\nconst int AnyPlayer = 0;');`);
  const source = db.prepare("SELECT * FROM galaxy_files").all();
  const first = reindexGalaxySymbols(file);
  assert.deepEqual(first.symbols, { function: 0, native: 1, constant: 1 });
  assert.deepEqual(reindexGalaxySymbols(file), first);
  assert.deepEqual(db.prepare("SELECT * FROM galaxy_files").all(), source);
  assert.equal(db.prepare("SELECT id FROM catalog_objects").get().id, "untouched");
  db.exec("CREATE TRIGGER reject_insert BEFORE INSERT ON galaxy_symbols BEGIN SELECT RAISE(ABORT,'test failure'); END;");
  assert.throws(() => reindexGalaxySymbols(file), /test failure/);
  assert.equal(db.prepare("SELECT count(*) n FROM galaxy_symbols").get().n, 2);
  const missing = path.join(dir, "missing.sqlite");
  assert.throws(() => reindexGalaxySymbols(missing), /does not exist/);
  assert.equal(existsSync(missing), false);
});
