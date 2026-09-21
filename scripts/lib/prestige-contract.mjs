import { DatabaseSync } from 'node:sqlite';
import { readLinkedCommanderProfile, prestigeActivationId } from './coop-profile-rules.mjs';

// Bind an explicit P1/P2/P3 request to official commander-profile facts, not
// to the plan's title. This is a narrow check, not a general NL verifier.
export function validatePrestigeContract(plan, { databaseFile, request = '', requestReplies = [] } = {}) {
  // A later user correction is authoritative; never use the model's candidate
  // as permission. A plain yes/no carries no new explicit prestige designation.
  const affirmativeClauses = text => text.split(/[；;。\n]/).filter(clause => {
    if (/不要|不改|不影响|不变|非\s*P|do not|don't|unchanged/i.test(clause)) return false;
    // A reply that preserves a prestige-derived ratio authorizes a companion
    // edit; it does not turn the separately requested base stat into a
    // prestige-only commander.stat.set.
    if (/(?:保留|保持)[^；;。\n]*P\s*[123][^；;。\n]*(?:派生|比例|关系|减免)|P\s*[123][^；;。\n]*(?:派生|比例|关系|减免)[^；;。\n]*(?:保留|保持)/i.test(clause)) return false;
    return !/保持/i.test(clause);
  }).join('\n');
  const affirmative = requestReplies.map(affirmativeClauses).reverse().find(reply => /\bP\s*[123]\b/i.test(reply)) ?? affirmativeClauses(request);
  const requested = [...new Set([...affirmative.matchAll(/\bP\s*([123])\b/gi)].map(m => Number(m[1])))];
  const stats = (plan.operations ?? []).filter(op => op.kind === 'commander.stat.set');
  if (!stats.some(op => op.prestigeUpgrade) && !(stats.length && requested.length === 1)) return;
  if (!databaseFile) throw Error('Prestige condition needs the commander-profile database.');
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    for (const op of stats) {
      const row = db.prepare('SELECT profile_json FROM commander_profiles WHERE commander_id=?').get(op.commanderId);
      const prestiges = row ? readLinkedCommanderProfile(db,op.commanderId,JSON.parse(row.profile_json)).prestiges ?? [] : [];
      if (op.prestigeUpgrade && !prestiges.some(p => prestigeActivationId(db,p) === op.prestigeUpgrade)) {
        throw Error(`${op.opId}: prestigeUpgrade is not a known prestige of ${op.commanderId}. Query commander.get for its ID.`);
      }
      if (requested.length === 1) {
        const entry=prestiges.find(p => Number(p.index) === requested[0] - 1);
        const expected = entry ? prestigeActivationId(db,entry) : null;
        if (!expected || op.prestigeUpgrade !== expected) {
          throw Error(`${op.opId}: original request specifies P${requested[0]}; commander-only activation is insufficient. Set prestigeUpgrade to ${expected ?? 'the verified prestige Upgrade ID'}.`);
        }
      }
    }
  } finally { db.close(); }
}
