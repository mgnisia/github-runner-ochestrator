// Lambda MicroVM lifecycle hook server — listens on port 8080 (catch-all) and 9000 (all hooks)
const http = require('http');
const { spawn, execFile } = require('child_process');
const zlib = require('zlib');
const { LambdaMicrovmsClient, TerminateMicrovmCommand } = require('@aws-sdk/client-lambda-microvms');

// Stored in module scope after the /run hook fires — used only for logging
let runnerName = null;

// ── Docker-in-Docker (snapshot-warmed) ────────────────────────────────────────
// HAS_DOCKER is true when the image was built from Dockerfile.docker (ENV RUNNER_HAS_DOCKER=1).
// When false (Dockerfile.base / slim flavor) dockerState is pre-set to 'ready', so /ready returns
// 200 immediately and startDockerDaemon/startDnsmasq are never called — no docker, no dnsmasq.
const HAS_DOCKER = process.env.RUNNER_HAS_DOCKER === '1';

// Start the Docker daemon as a child of this process (the CMD entrypoint) at startup, BEFORE we
// signal /ready. Lambda MicroVMs snapshots the full memory state of the CMD process tree the
// moment /ready returns 200, so a daemon that is already running and warm at that point is
// captured in the snapshot and restored — pre-warmed — on every MicroVM run. That is why /ready
// is gated on docker readiness (below) and why entrypoint.sh no longer starts dockerd per job.
// A daemon started in a Dockerfile RUN step would NOT be captured: the snapshot only includes the
// ENTRYPOINT/CMD process tree, not ephemeral build-layer processes.
// Best-effort: if the daemon never comes up we mark it 'failed' and let /ready proceed anyway, so
// jobs that don't need Docker are not blocked.
let dockerState = HAS_DOCKER ? 'starting' : 'ready'; // 'starting' | 'ready' | 'failed'
const DOCKER_READY_DEADLINE_MS = 50_000; // stay within the readyTimeoutInSeconds build hook

// ── SAM base image prewarm (snapshot-warmed) ──────────────────────────────────
// Pulling the SAM bundling base image BEFORE /ready returns 200 ensures it lands in the MicroVM
// snapshot layer and is already present in dockerd's image cache on every restored run. This
// eliminates the ~24s cold pull that `cdk synth` (aws-news/backend) paid on every job.
//
// DIGEST PIN: The digest below must match the base image used by the `uv_python_lambda` CDK
// bundling image in the aws-news/backend repo. Pinning by digest guarantees the pre-pull is a
// cache hit at synth time — Docker skips the network round-trip when the manifest is already
// local. A digest MISMATCH is benign (challenge C2): the snapshot will simply contain a
// different layer than the synth expects, and cdk synth will pull its required digest fresh, just
// as it did before this prewarm. Mismatches waste snapshot space but never break builds.
// Update this constant whenever aws-news/backend bumps its SAM base image.
const SAM_BASE_IMAGE = 'public.ecr.aws/sam/build-python3.13@sha256:caa464dc2628d5e9e87936142b571d3cbd3c5cc3a64cde9471963bfa5c54d2c8';

// 'pending' while pull is in flight, 'done' on success, 'failed' on error/timeout.
// HAS_DOCKER=false: pre-set to 'done' so the no-docker flavor is completely unaffected and
// /ready returns 200 immediately without waiting for a pull that would never start.
let prewarmState = HAS_DOCKER ? 'pending' : 'done'; // 'pending' | 'done' | 'failed'

// PREWARM_DEADLINE_MS + DOCKER_READY_DEADLINE_MS must together fit within readyTimeoutInSeconds
// configured in scripts/build-microvm-image.ts (currently 180s = 180_000ms). With dockerd capped
// at 50s and prewarm at 120s that leaves 10s of headroom before the build hook times out.
const PREWARM_DEADLINE_MS = 120_000;

// Pulls SAM_BASE_IMAGE into the local dockerd image cache. Called only after the daemon is ready.
// On success: prewarmState='done'. On timeout or error: prewarmState='failed', logs prominently.
// Failure is non-blocking — /ready still returns 200 so jobs are never stuck (best-effort).
function prewarmDockerImages() {
  const start = Date.now();
  console.log(`Prewarming SAM base image: ${SAM_BASE_IMAGE}`);
  execFile(
    'docker',
    ['pull', SAM_BASE_IMAGE],
    { timeout: PREWARM_DEADLINE_MS },
    (err) => {
      if (!err) {
        prewarmState = 'done';
        console.log(`SAM base image prewarm complete (${Date.now() - start}ms).`);
      } else {
        prewarmState = 'failed';
        console.error(
          `SAM base image prewarm FAILED after ${Date.now() - start}ms — cdk synth will pull fresh.`,
          err.message,
        );
      }
    },
  );
}

function startDockerDaemon() {
  // Pass --dns 172.17.0.1 so every container (including nested `docker build` builds) receives
  // the dnsmasq forwarder on the docker0 bridge gateway as its resolver. Without this flag,
  // Docker inherits the host's /etc/resolv.conf which only contains 127.0.0.2 — a loopback
  // address that is unreachable from inside a container's network namespace.
  const daemon = spawn('dockerd', ['--dns', '172.17.0.1'], { stdio: ['ignore', 'inherit', 'inherit'] });
  daemon.on('error', (err) => {
    console.error('Failed to spawn dockerd:', err);
    dockerState = 'failed';
    prewarmState = 'failed'; // can't pull without a daemon
  });
  daemon.on('exit', (code, signal) => {
    console.error(`dockerd exited — code: ${code ?? '(null)'}, signal: ${signal ?? '(null)'}`);
    if (dockerState !== 'ready') {
      dockerState = 'failed';
      prewarmState = 'failed'; // can't pull without a daemon
    }
  });

  const start = Date.now();
  const poll = () => {
    execFile('docker', ['info'], (err) => {
      if (!err) {
        dockerState = 'ready';
        console.log('Docker daemon is ready.');
        // Kick off image prewarm now that dockerd is up — must run after daemon ready, not before.
        prewarmDockerImages();
        return;
      }
      if (Date.now() - start > DOCKER_READY_DEADLINE_MS) {
        dockerState = 'failed';
        prewarmState = 'failed'; // daemon never came up; no pull possible
        console.error('Docker daemon did not become ready in time — proceeding without it. Jobs that require Docker may fail.');
        return;
      }
      setTimeout(poll, 1000);
    });
  };
  poll();
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
  // Required during image creation so Lambda knows the server is up. We gate the snapshot on BOTH
  // the Docker daemon being ready AND the SAM base image prewarm completing, so both are captured
  // warm in the MicroVM snapshot: return 503 while either is still in progress (Lambda retries
  // until readyTimeoutInSeconds), then 200 once both are settled (ready or failed).
  // Best-effort: a docker/prewarm failure still returns 200 so non-docker jobs are never blocked.
  if (method === 'POST' && url === '/aws/lambda-microvms/runtime/v1/ready') {
    if (dockerState === 'starting' || prewarmState === 'pending') {
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
// HAS_DOCKER=false (Dockerfile.base): dockerState is already 'ready'; neither daemon is started.
if (HAS_DOCKER) {
  startDockerDaemon();
  startDnsmasq();
}

// Both ports share the same handler: 8080 acts as the catch-all, 9000 receives all hooks.
for (const port of [8080, 9000]) {
  http.createServer(handleRequest).listen(port, '0.0.0.0', () => {
    console.log(`Listening on 0.0.0.0:${port}`);
  });
}
