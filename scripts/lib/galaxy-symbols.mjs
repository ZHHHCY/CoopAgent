import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

export const GALAXY_SYMBOL_VERSION = 2;

// Declaration extraction, not a compiler. Preserve offsets while masking
// comments/strings; exclude function-local declarations from the global index.
export function extractGalaxySymbols(source) {
  const text = String(source).replaceAll("\r\n", "\n");
  const code = text.replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
    (s) => s.replace(/[^\n]/g, " "));
  const functions = /^[ \t]*((?:(?:static|native)\s+)*)([A-Za-z_]\w*(?:\s*\[[^\]\n]*\])*)\s+([A-Za-z_]\w*)\s*\(([^()]*)\)\s*([;{])/gm;
  const constants = /^[ \t]*(?:static\s+)?const\s+([A-Za-z_]\w*(?:\s*\[[^\]\n]*\])*)\s+([A-Za-z_]\w*)\s*=([^;]*);/gm;
  const candidates = [
    ...Array.from(code.matchAll(functions), (m) => ({ at: m.index, match: m, function: true })),
    ...Array.from(code.matchAll(constants), (m) => ({ at: m.index, match: m, function: false })),
  ].sort((a, b) => a.at - b.at);
  let offset = 0, depth = 0, line = 1;
  const symbols = [];
  for (const c of candidates) {
    while (offset < c.at) {
      const ch = code[offset++];
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      else if (ch === "\n") line++;
    }
    if (depth !== 0) continue;
    const m = c.match;
    const declaration = text.slice(c.at, c.at + m[0].length).trim();
    if (c.function) {
      const parameters = m[4].trim() ? m[4].split(",").map((p) => {
        const param = /^\s*([A-Za-z_]\w*(?:\s*\[[^\]]*\])*)\s+([A-Za-z_]\w*)\s*$/.exec(p);
        return param ? { type: param[1].replace(/\s+/g, ""), name: param[2] } : { declaration: p.trim() };
      }) : [];
      symbols.push({ name: m[3], kind: /\bnative\b/.test(m[1]) ? "native" : "function", line,
        signature: declaration.slice(0, -1).trim().replace(/\s+/g, " ") + ";",
        returnType: m[2].replace(/\s+/g, ""), parameters });
    } else {
      symbols.push({ name: m[2], kind: "constant", line,
        signature: declaration, type: m[1].replace(/\s+/g, ""),
        value: declaration.slice(declaration.indexOf("=") + 1, -1).trim() });
    }
  }
  return symbols;
}

// Only the derived index changes. Query code never silently upgrades a database.
export function reindexGalaxySymbols(databaseFile) {
  if (!existsSync(databaseFile)) throw Error("Database does not exist");
  const db = new DatabaseSync(databaseFile, { timeout: 2000 });
  try {
    db.exec("BEGIN IMMEDIATE");
    const rows = db.prepare("SELECT source_file,contents FROM galaxy_files ORDER BY source_file").all();
    db.exec("DELETE FROM galaxy_symbols");
    const insert = db.prepare("INSERT OR IGNORE INTO galaxy_symbols(source_file,name,kind,line) VALUES (?,?,?,?)");
    const counts = { function: 0, native: 0, constant: 0 };
    for (const row of rows) for (const s of extractGalaxySymbols(row.contents)) {
      insert.run(row.source_file, s.name, s.kind, s.line); counts[s.kind]++;
    }
    db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES (?,?)").run("galaxySymbolVersion", String(GALAXY_SYMBOL_VERSION));
    db.exec("COMMIT");
    return { files: rows.length, symbols: counts, galaxySymbolVersion: GALAXY_SYMBOL_VERSION };
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  } finally { db.close(); }
}
