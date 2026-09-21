import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import path from "node:path";
import { DOMParser } from "@xmldom/xmldom";
import { commanderUpgradeGalaxy } from "../../../scripts/lib/patch-plan-executor.mjs";
import { attachGameAProjection, canonicalFieldPath } from "./game-a-projection.mjs";

/** The same Catalog projection as query/UI, rooted at actual staged files.
 * No PatchPlan operations are evaluated here. Caller owns the project lock. */
export function openGameAArtifacts({ databaseFile, repoRoot, coreRoot, commanderId = null }) {
  const database = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    database.exec('PRAGMA temp_store=MEMORY; BEGIN');
    const projection = attachGameAProjection(database, { repoRoot, coreRoot, commanderId });
    const objectQuery = database.prepare(`SELECT * FROM catalog_objects
      WHERE lower(catalog)=lower(?) AND lower(object_id)=lower(?)`);
    const fieldsQuery = database.prepare(`SELECT path,value,inheritance_depth FROM catalog_fields
      WHERE catalog=? AND object_id=? ORDER BY path`);
    const textQuery = database.prepare(`SELECT value FROM localized_text
      WHERE lower(locale)=lower(?) AND text_key=?`);
    const object = (catalog, id) => objectQuery.get(catalog, id);
    const redirects = new Map();
    const manifest = JSON.parse(readFileSync(path.join(coreRoot, "GameA.Core.json"), "utf8"));
    for (const module of manifest.galaxy?.modules ?? []) {
      const match = /^Base\.SC2Data\/Generated\/CommanderUpgrade_([a-f0-9]{16})\.galaxy$/.exec(module.path);
      if (!match || module.configure !== `GameA_CommanderUpgrade_${match[1]}_Configure`) continue;
      const upgradeId = `GameACommanderClone${match[1]}`;
      const upgrade = object("Upgrade", upgradeId);
      if (!upgrade || !commanderId) continue;
      const source = readFileSync(path.join(coreRoot, module.path), "utf8");
      if (source !== commanderUpgradeGalaxy({ commanderId, upgradeId, configureFunction: module.configure })) continue;
      // Generated EffectArray stores Reference/Operation/Value as XML attributes.
      // The shared projection retains '.@Reference'; child-field spellings also
      // exist. Normalize both before interpreting the actual generated Upgrade.
      const rows = new Map(fieldsQuery.all("Upgrade", upgradeId)
        .map(row => [canonicalFieldPath(row.path), row.value]));
      for (const [fieldPath, reference] of rows) {
        if (!fieldPath.endsWith(".reference")) continue;
        const prefix = fieldPath.slice(0, -"reference".length);
        if (rows.get(`${prefix}operation`) !== "Set") continue;
        // XML Value/value attributes are flattened as the element's own value,
        // whereas an explicit <Value> child retains the '.Value' suffix.
        const value = rows.get(`${prefix}value`) ?? rows.get(prefix.slice(0, -1));
        if (typeof value !== "string" || value === "") continue;
        const [catalog, id, ...field] = reference.split(",");
        const key = `${catalog}/${id}/${canonicalFieldPath(field.join(","))}`;
        if (redirects.has(key) && redirects.get(key) !== value) throw new Error(`Ambiguous generated redirect: ${key}`);
        redirects.set(key, value);
      }
    }
    const fields = (catalog, id, scoped = true) => {
      const row = object(catalog, id);
      if (!row) return [];
      return scoped ? fieldsQuery.all(row.catalog, row.object_id)
        : [...projection.catalogFields(row.catalog, row.object_id).values()];
    };
    return {
      database, projection, object, fields,
      field(catalog, id, fieldPath, scoped = true) {
        const redirectKey = `${catalog}/${id}/${canonicalFieldPath(fieldPath)}`;
        if (scoped && redirects.has(redirectKey)) return redirects.get(redirectKey);
        if (fieldPath === "@parent") return object(catalog, id)?.parent_id;
        // Attributes on the Catalog root are not flattened into catalog_fields.
        if (fieldPath === "@unitName") {
          const source = object(catalog, id)?.direct_xml;
          const element = source && new DOMParser().parseFromString(source, "application/xml").documentElement;
          return element?.hasAttribute("unitName") ? element.getAttribute("unitName") : undefined;
        }
        let matches = fields(catalog, id, scoped).filter((row) =>
          canonicalFieldPath(row.path) === canonicalFieldPath(fieldPath));
        if (!matches.length) matches = fields(catalog, id, scoped).filter((row) =>
          canonicalFieldPath(row.path).replaceAll("[0]", "") === canonicalFieldPath(fieldPath).replaceAll("[0]", ""));
        if (matches.length > 1) throw new Error(`Ambiguous artifact field: ${catalog}/${id}/${fieldPath}`);
        return matches[0]?.value;
      },
      references(catalog, id, matches) {
        return fields(catalog, id).filter((row) => matches(row.path) && row.value !== "")
          .map((row) => ({ fieldPath: row.path, objectId: row.value }));
      },
      text: (locale, textKey) => textQuery.get(locale, textKey)?.value,
      close: () => database.close(),
    };
  } catch (error) {
    database.close();
    throw error;
  }
}
