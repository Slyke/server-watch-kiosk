import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
const exec = promisify(execFile);
const name = 'service-board-smoke-' + process.pid + '-' + Date.now();
const image = process.argv[2] ?? 'service-watcher-kiosk:validation';
const docker = async (...args) => (await exec('docker', args, { maxBuffer: 1024 * 1024 })).stdout;
try {
  await docker('run', '-d', '--name', name, '--init', '--label', 'service-board.test=smoke', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--pids-limit', '128', '--memory', '512m', '--tmpfs', '/tmp:rw,noexec,nosuid,size=32m', '-e', 'LOG_K8S_METADATA_ENABLED=true', '-e', 'K8S_POD_NAME=simulated-smoke', image);
  let ready = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    try { await docker('exec', name, 'node', '-e', "fetch('http://127.0.0.1:8098/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"); ready = true; break; }
    catch { await new Promise(resolve => setTimeout(resolve, 200)); }
  }
  assert.ok(ready, 'Nonroot/read-only/no-network container starts');
  const result = JSON.parse(await docker('exec', name, 'node', '-e', `const fs=require('node:fs'); (async()=>{const base='http://127.0.0.1:8098'; const status=await(await fetch(base+'/api/v1/status')).json(); const live=await(await fetch(base+'/livez')).json(); const metrics=await(await fetch(base+'/metrics')).text(); const html=await(await fetch(base+'/')).text(); console.log(JSON.stringify({count:status.services.length,mode:status.mode,live,synthetic:metrics.includes('service_board_service_state'),frontend:html.includes('/assets/'),uid:process.getuid(),secretFile:fs.existsSync('/app/secrets.json5')}));})().catch(()=>process.exit(1));`));
  assert.equal(result.count, 34); assert.equal(result.mode, 'demo'); assert.equal(result.uid, 1000);
  assert.equal(result.live.ok, true); assert.ok(result.live.version); assert.ok(result.live.buildHash); assert.ok(result.live.correlation_id);
  assert.equal(result.synthetic, false); assert.equal(result.frontend, true); assert.equal(result.secretFile, false);
  const logs = await docker('logs', name);
  const startup = logs.trim().split('\n').map(line => JSON.parse(line)).find(entry => entry.loggerKey === 'SERVICE_BOOT_DIAGNOSTICS');
  assert.ok(startup.kubernetes); assert.equal(startup.context.kubernetes, undefined);
  await docker('stop', '--time', '5', name);
  const [container] = JSON.parse(await docker('inspect', name));
  assert.equal(container.State.ExitCode, 0, 'Graceful shutdown exits successfully');
  console.log('PASS: container starts offline, serves 34 tiles/assets/probes, runs nonroot/read-only, omits secrets/synthetic metrics, logs build metadata once, and shuts down cleanly.');
} finally { await docker('rm', '-f', name).catch(() => {}); }
