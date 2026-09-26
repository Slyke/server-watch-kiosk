import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const { version } = JSON.parse(fs.readFileSync('package.json', 'utf8'));
let buildHash = process.env.BUILD_HASH ?? 'unknown';
if (buildHash === 'unknown') {
  try { buildHash = execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* Local source archive or initial checkout. */ }
}
fs.writeFileSync('build-info.json', JSON.stringify({ version, buildHash }, null, 2) + '\n');
