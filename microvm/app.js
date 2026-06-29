// Lambda MicroVM lifecycle hook server — listens on port 8080 (catch-all) and 9000 (all hooks)
const http = require('http');
const { spawn, execFile } = require('child_process');
const zlib = require('zlib');
const { LambdaMicrovmsClient, TerminateMicrovmCommand } = require('@aws-sdk/client-lambda-microvms');

// Stored in module scope after the /run hook fires — used only for logging
let runnerName = null;

// ── Docker-in-Docker (snapshot-warmed, per-job bounced) ───────────────────────
// The Docker daemon is spawned here at startup (build time), before /ready returns 200. Lambda
// MicroVMs snapshots the full CMD process tree at that moment, so a warm, healthy daemon is
// captured and restored on every run — saving the ~1 min cold-start penalty.
//
// However, snapshot/restore freezes and then thaws all in-memory state, including the gRPC
// session sockets that BuildKit holds open. The restored daemon keeps a dead, never-released
// session connection slot, causing BuildKit to log perpetual:
//   "session healthcheck failed fatally ... only one connection allowed"
//
// Fix: after restore, bounce (restart) dockerd once per job in the /run hook before the GitHub
// Actions runner starts. The overlay2 layers are already on disk from the warm snapshot, so the
// fresh daemon is ready in ~1-2s — far cheaper than a cold start. This restart is intentional;
// the per-job exit is suppressed (restartingDocker flag) so it does not look like a crash.
//
// dnsmasq is NOT restarted — its --bind-dynamic flag automatically re-binds to 172.17.0.1 when
// dockerd recreates the docker0 bridge on the fresh daemon start.
//
// Best-effort: if the daemon never comes up we mark it 'failed' and let /ready proceed anyway,
// so jobs that don't need Docker are not blocked.
let dockerState = 'starting';  // 'starting' | 'ready' | 'failed'
let dockerdProcess = null;     // retained so restartDockerDaemon() can kill it
let restartingDocker = false;  // suppresses exit-handler noise during intentional bounces
const DOCKER_READY_DEADLINE_MS = 50_000; // stay within the 60s readyTimeoutInSeconds build hook

// Polls `docker info` until it succeeds or the deadline is reached.
// Returns a Promise that resolves to true (ready) or false (timed out).
// Used by both build-time startup and run-time restart to avoid duplicating the poll loop.
function waitForDockerReady(deadlineMs) {
  return new Promise((resolve) => {
    const start = Date.now();
    const poll = () => {
      execFile('docker', ['info'], (err) => {
        if (!err) {
          resolve(true);
          return;
        }
        if (Date.now() - start > deadlineMs) {
          resolve(false);
          return;
        }
        setTimeout(poll, 1000);
      });
    };
    poll();
  });
}

// Spawns `dockerd --dns 172.17.0.1` and attaches error/exit handlers. Returns the child process.
// The restartingDocker flag suppresses the exit log and state change during intentional bounces
// so a controlled restart does not look like a crash.
function spawnDockerDaemon() {
  // Pass --dns 172.17.0.1 so every container (including nested `docker build` builds) receives
  // the dnsmasq forwarder on the docker0 bridge gateway as its resolver. Without this flag,
  // Docker inherits the host's /etc/resolv.conf which only contains 127.0.0.2 — a loopback
  // address that is unreachable from inside a container's network namespace.
  const proc = spawn('dockerd', ['--dns', '172.17.0.1'], { stdio: ['ignore', 'inherit', 'inherit'] });
  proc.on('error', (err) => {
    if (restartingDocker) return;
    console.error('Failed to spawn dockerd:', err);
    dockerState = 'failed';
  });
  proc.on('exit', (code, signal) => {
    if (restartingDocker) return; // intentional bounce — restartDockerDaemon() will re-spawn
    console.error(`dockerd exited — code: ${code ?? '(null)'}, signal: ${signal ?? '(null)'}`);
    if (dockerState !== 'ready') dockerState = 'failed';
  });
  return proc;
}

// Build-time: spawn the daemon and wait for readiness before /ready is answered.
// Times and logs the warm-up so snapshot build latency is observable.
async function startDockerDaemon() {
  const buildStart = Date.now();
  dockerdProcess = spawnDockerDaemon();
  const ready = await waitForDockerReady(DOCKER_READY_DEADLINE_MS);
  const elapsed = Date.now() - buildStart;
  if (ready) {
    dockerState = 'ready';
    console.log('Docker daemon is ready.');
    console.log(`[timing] build-phase docker warm-up: ${elapsed}ms`);
  } else {
    dockerState = 'failed';
    console.error('Docker daemon did not become ready in time — proceeding without it. Jobs that require Docker may fail.');
    console.error(`[timing] build-phase docker warm-up: ${elapsed}ms (timed out)`);
  }
}

// Run-time: bounce the daemon once per job after restore so BuildKit gets a fresh session socket.
// SIGTERM → wait for exit (SIGKILL fallback after 5s) → re-spawn → wait for readiness.
// Best-effort: logs on failure and proceeds so non-docker jobs are not blocked.
async function restartDockerDaemon() {
  const restartStart = Date.now();
  console.log('Bouncing Docker daemon post-restore (snapshot-frozen BuildKit session sockets cannot survive restore)...');

  try {
    restartingDocker = true;
    if (dockerdProcess && dockerdProcess.exitCode === null) {
      dockerdProcess.kill('SIGTERM');
      await new Promise((resolve) => {
        const fallback = setTimeout(() => {
          console.warn('dockerd did not exit within 5s — sending SIGKILL');
          if (dockerdProcess && dockerdProcess.exitCode === null) dockerdProcess.kill('SIGKILL');
        }, 5000);
        dockerdProcess.once('exit', () => {
          clearTimeout(fallback);
          resolve();
        });
      });
    }
  } finally {
    restartingDocker = false;
  }

  dockerState = 'starting';
  dockerdProcess = spawnDockerDaemon();

  const ready = await waitForDockerReady(DOCKER_READY_DEADLINE_MS);
  const elapsed = Date.now() - restartStart;
  if (ready) {
    dockerState = 'ready';
    console.log('Docker daemon restarted and ready.');
    console.log(`[timing] run-phase docker restart: ${elapsed}ms`);
  } else {
    dockerState = 'failed';
    console.error('Docker daemon did not become ready after restart — proceeding. Jobs that require Docker may fail.');
    console.error(`[timing] run-phase docker restart: ${elapsed}ms (timed out)`);
  }
}

// ── DNS forwarder (snapshot-warmed) ───────────────────────────────────────────
// Start dnsmasq as a child of this process (the CMD entrypoint) so it is captured in the
// Lambda MicroVM snapshot alongside dockerd and is pre-warmed on every run.
//
// WHY THIS IS NEEDED:
// Lambda's DNS proxy is bound to 127.0.0.2 (loopback) in /etc/resolv.conf. Loopback
// addresses are only reachable within the host network namespace — any Docker container
// gets its own network namespace where 127.0.0.2 is unreachable. Docker detects loopback
// nameservers, strips them, and substitutes its hardcoded fallback 8.8.8.8/8.8.4.4; this
// VPC blocks public DNS egress, so all resolution inside containers fails.
//
// FIX: dnsmasq listens on 172.17.0.1 (the docker0 bridge gateway, reachable from every
// Docker container), reads /etc/resolv.conf to find 127.0.0.2, and forwards queries there.
// dockerd is started with --dns 172.17.0.1 so every container is handed this resolver.
//
// SNAPSHOT CAPTURE: Like dockerd, this must be spawned in the CMD/ENTRYPOINT process tree.
// A process started in a Dockerfile RUN step lives only for that build layer and is NOT
// captured in the snapshot — only the live CMD process tree is frozen.
//
// INTERFACE TIMING: docker0 is created by dockerd at daemon startup, which may race with
// dnsmasq. --bind-dynamic handles this: dnsmasq starts without 172.17.0.1, then
// automatically picks up the interface once docker0 appears — no retry logic needed here.
// This same --bind-dynamic behaviour means dnsmasq does NOT need to be restarted when
// dockerd is bounced per-job: it re-binds to 172.17.0.1 once the fresh docker0 appears.
function startDnsmasq() {
  const proc = spawn(
    'dnsmasq',
    [
      '--keep-in-foreground',    // stay a foreground child process (no daemonize); captured in snapshot
      '--bind-dynamic',          // bind 172.17.0.1 lazily when docker0 appears after dockerd starts
      '--listen-address=172.17.0.1', // docker0 bridge gateway — reachable from all containers
      // upstream: dnsmasq reads /etc/resolv.conf by default, picking up 127.0.0.2 automatically
    ],
    { stdio: ['ignore', 'inherit', 'inherit'] },
  );
  proc.on('error', (err) => {
    console.error('Failed to spawn dnsmasq:', err);
  });
  proc.on('exit', (code, signal) => {
    console.error(`dnsmasq exited — code: ${code ?? '(null)'}, signal: ${signal ?? '(null)'}`);
  });
  console.log('dnsmasq forwarder started (172.17.0.1 → 127.0.0.2 via /etc/resolv.conf)');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

function runnerNameFromJitConfig(encodedJitConfig) {
  const outer = JSON.parse(Buffer.from(encodedJitConfig, 'base64').toString('utf8'));
  const runner = JSON.parse(Buffer.from(outer['.runner'], 'base64').toString('utf8'));
  return runner.AgentName;
}

// Accepts the raw run-hook payload, which is either:
//   (a) the plain encoded_jit_config (a base64 string), or
//   (b) base64(gzip(encoded_jit_config)) — produced by: echo -n "$JIT_CONFIG" | gzip | base64
// Detects the gzip magic bytes (0x1f 0x8b) after the outer base64 decode and decompresses if
// present. Node's Buffer.from(…, 'base64') silently strips embedded newlines, so macOS base64
// line-wrapped output is handled automatically.
function decodeJitConfig(payload) {
  const buf = Buffer.from(payload, 'base64');
  if (buf[0] === 0x1f && buf[1] === 0x8b) {
    return zlib.gunzipSync(buf).toString('utf8');
  }
  return payload;
}

// Calls TerminateMicrovm via the AWS JS SDK so the VM stops promptly after the runner exits.
// If microvmId is missing (e.g. local dev / incomplete payload), logs a warning and skips.
// Errors are caught and logged — a failed terminate is not fatal; the idle policy is the fallback.
async function terminateSelf(microvmId) {
  if (!microvmId) {
    console.warn('Warning: microvmId is missing — skipping self-termination');
    return;
  }
  const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'eu-west-1';
  const client = new LambdaMicrovmsClient({ region });
  try {
    await client.send(new TerminateMicrovmCommand({ microvmIdentifier: microvmId }));
    console.log('TerminateMicrovm succeeded for:', microvmId);
  } catch (err) {
    console.error('TerminateMicrovm failed for:', microvmId, err);
  }
}

async function handleRequest(req, res) {
  const { method, url } = req;
  console.log(`${new Date().toISOString()} ${method} ${url}`);

  // POST /aws/lambda-microvms/runtime/v1/ready
  // Required during image creation so Lambda knows the server is up. We additionally gate the
  // snapshot on the Docker daemon being ready, so it is captured warm: return 503 while it is
  // still starting (Lambda retries until readyTimeoutInSeconds), then 200 once it is ready or has
  // failed (best-effort — a docker failure should not block non-docker jobs).
  if (method === 'POST' && url === '/aws/lambda-microvms/runtime/v1/ready') {
    if (dockerState === 'starting') {
      res.writeHead(503);
      res.end();
      return;
    }
    res.writeHead(200);
    res.end();
    return;
  }

  // POST /aws/lambda-microvms/runtime/v1/run
  // Receives per-instance JIT config, derives the runner name, and spawns entrypoint.sh.
  // Before spawning, restartDockerDaemon() bounces the snapshot-restored daemon so BuildKit
  // starts with a fresh session socket (snapshot-frozen sockets cannot survive restore).
  // Termination is handled here: when the child exits (regardless of exit code or signal),
  // terminateSelf() is called so the VM stops promptly without relying on the AWS CLI.
  if (method === 'POST' && url === '/aws/lambda-microvms/runtime/v1/run') {
    try {
      const body = await readBody(req);
      const { microvmId, runHookPayload } = JSON.parse(body);
      const encodedJitConfig = decodeJitConfig(runHookPayload);

      runnerName = runnerNameFromJitConfig(encodedJitConfig);
      console.log('MicroVM ID:', microvmId ?? '(unknown)');
      console.log('Runner name from JIT config:', runnerName);

      // Bounce the daemon before starting the runner — best-effort, never throws.
      try {
        await restartDockerDaemon();
      } catch (err) {
        console.error('Docker daemon restart encountered an unexpected error — proceeding:', err);
      }

      const child = spawn('./entrypoint.sh', [], {
        stdio: 'inherit',
        env: { ...process.env, ENCODED_JIT_CONFIG: encodedJitConfig },
      });

      // Attach the exit listener before returning 200 — this is synchronous and non-blocking.
      // terminateSelf fires regardless of exit code/signal so the VM is torn down even on failure.
      child.on('exit', (code, signal) => {
        console.log(`Runner process exited — code: ${code ?? '(null)'}, signal: ${signal ?? '(null)'}`);
        terminateSelf(microvmId);
      });

      res.writeHead(200);
      res.end();
    } catch (err) {
      console.error('Error handling /run:', err);
      res.writeHead(500);
      res.end();
    }
    return;
  }

  // POST /aws/lambda-microvms/runtime/v1/terminate
  // Fired by Lambda after app.js itself called TerminateMicrovm on child exit. The JIT runner
  // has already auto-deregistered from GitHub at this point, so there is nothing to clean up;
  // we just ack.
  if (method === 'POST' && url === '/aws/lambda-microvms/runtime/v1/terminate') {
    console.log('Terminate received for runner:', runnerName ?? '(unknown)');
    res.writeHead(200);
    res.end();
    return;
  }

  // Catch-all — useful for debugging unexpected requests
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'ok', path: url }));
}

// Kick off the Docker daemon and the dnsmasq DNS forwarder now, so both are warm before /ready
// is answered and captured in the MicroVM snapshot.
//
// Dependency: dockerd creates the docker0 bridge (gateway 172.17.0.1) that dnsmasq listens on.
// We start dockerd first and dnsmasq immediately after. dnsmasq's --bind-dynamic flag lets it
// start without 172.17.0.1 being present and bind once docker0 appears — no explicit wait needed.
// /ready is gated only on dockerd readiness (below); dnsmasq is best-effort like docker's own
// health — if it fails to start, container DNS will fall back to Docker's built-in behaviour.
startDockerDaemon().catch((err) => {
  console.error('Unexpected error in startDockerDaemon:', err);
  dockerState = 'failed';
});
startDnsmasq();

// Both ports share the same handler: 8080 acts as the catch-all, 9000 receives all hooks.
for (const port of [8080, 9000]) {
  http.createServer(handleRequest).listen(port, '0.0.0.0', () => {
    console.log(`Listening on 0.0.0.0:${port}`);
  });
}
