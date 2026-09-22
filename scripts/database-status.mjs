import { inspectCoopDatabase } from './lib/database-location.mjs';
import { workspaceRoot } from './lib/project-context.mjs';
const [repoRoot = workspaceRoot(), databaseFile] = process.argv.slice(2);
console.log(JSON.stringify(inspectCoopDatabase({ repoRoot, databaseFile })));
