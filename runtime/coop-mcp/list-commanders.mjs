#!/usr/bin/env node

import { createReadStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { createGunzip } from "node:zlib";

import { COOP_DATABASE_BUSY_TIMEOUT_MS, createCoopSearch } from "./lib/coop-search.mjs";

async function resolveCascPaths(build, assets) {
  const indexPath = path.join(
    process.env.LOCALAPPDATA ??
      process.env.XDG_DATA_HOME ??
      (process.platform === "win32"
        ? path.join(os.homedir(), "AppData", "Local")
        : path.join(os.homedir(), ".local", "share")),
    "CoopAgent",
    "casc",
    build,
    "known-files.tsv.gz",
  );
  const wanted = new Map(
    assets.map((asset) => [
      `\\base.sc2assets\\${asset.toLowerCase().replaceAll("/", "\\")}`,
      asset,
    ]),
  );
  const resolved = new Map();
  const lines = readline.createInterface({
    input: createReadStream(indexPath).pipe(createGunzip()),
    crlfDelay: Infinity,
  });

  for await (const line of lines) {
    const [logicalPath, , available] = line.split("\t");
    if (available !== "1") continue;
    const normalized = logicalPath.toLowerCase().replaceAll("/", "\\");
    for (const [suffix, asset] of wanted) {
      if (!resolved.has(asset) && normalized.endsWith(suffix)) {
        resolved.set(asset, logicalPath);
      }
    }
    if (resolved.size === wanted.size) break;
  }
  return resolved;
}

try {
  const search = createCoopSearch();
  const result = search.execute({
    operation: "commander.list",
    limit: 30,
  });
  const databaseLocation = search.locateDatabase();
  const database = new DatabaseSync(databaseLocation.databaseFile, { readOnly: true, timeout: COOP_DATABASE_BUSY_TIMEOUT_MS });
  let portraitRows;
  try {
    portraitRows = database
      .prepare(`
        SELECT c.id, c.commander_object_id AS commanderObjectId, f.value AS portraitAsset
        FROM commanders c
        JOIN catalog_fields f
          ON f.catalog='Commander'
         AND f.object_id=c.commander_object_id
         AND lower(f.path)='portrait'
      `)
      .all();
  } finally {
    database.close();
  }

  const portraits = new Map(
    portraitRows.map((row) => {
      const asset = row.portraitAsset
        .replaceAll("##id##", row.commanderObjectId.toLowerCase())
        .replaceAll("\\", "/");
      return [row.id, asset];
    }),
  );
  const cascPaths = await resolveCascPaths(result.database.sc2Build, [...portraits.values()]);
  result.items = result.items.map((commander) => {
    const portraitAsset = portraits.get(commander.id);
    return {
      ...commander,
      portraitAsset,
      portraitCascPath: portraitAsset ? cascPaths.get(portraitAsset) : undefined,
    };
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
