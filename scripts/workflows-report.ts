// `npx tsx scripts/workflows-report.ts <site id or origin> [--runs 10] [--json]` (SP-041b).
//
// Read-only report for the Render Workflows check (docs/deploy.md §Render Workflows check): the
// site's crawl runs with the mode each ran in (inproc / workflows), connect → discovery-crawl
// time against spec 03's 4 minutes, page / snapshot / record / version counts with duplicate
// checks, and the latest payout batches. Run it from the spigot-api Shell on Render (the
// database is private). Needs DATABASE_URL in the environment; prints ids and counts only.
import pg from 'pg';
import { parseArgs } from 'node:util';
import { formatReport, workflowsReport } from './workflows-report.lib.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { runs: { type: 'string', default: '10' }, json: { type: 'boolean', default: false } },
});
const site = positionals[0];
const url = process.env.DATABASE_URL;
if (!site || !url) {
  console.error(
    'usage: DATABASE_URL=… npx tsx scripts/workflows-report.ts <site id or origin> [--runs 10] [--json]',
  );
  process.exit(2);
}

const pool = new pg.Pool({ connectionString: url, max: 1 });
try {
  const report = await workflowsReport(pool, site, { runs: Number(values.runs) || 10 });
  if (!report) {
    console.error(`no site ${site}`);
    process.exitCode = 1;
  } else {
    console.log(values.json ? JSON.stringify(report, null, 2) : formatReport(report));
  }
} finally {
  await pool.end();
}
