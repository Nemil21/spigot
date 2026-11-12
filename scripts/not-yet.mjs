#!/usr/bin/env node
// Placeholder for root scripts whose owning ticket hasn't landed yet (SP-001a). The owning
// ticket replaces the script line in package.json; this file can go once none point here.
const [script, ticket] = process.argv.slice(2);
console.error(`npm run ${script} is not implemented yet (owned by ${ticket}).`);
process.exit(1);
