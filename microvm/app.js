// Lambda MicroVM lifecycle hook server — listens on port 8080 (catch-all) and 9000 (all hooks)
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
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

// ── SAM base image + uv bundling image prewarm (snapshot-warmed) ─────────────
// Pulling the SAM bundling base image AND building the uv bundling image BEFORE /ready returns
// 200 ensures both land in the MicroVM snapshot and are available cache-hit-free on every
// restored run. This eliminates:
//   • ~24s cold SAM pull that `cdk synth` (aws-news/backend) paid on every job (Phase 1).
//   • ~30s `pip install uv==0.11.21` layer that CDK's DockerImage.fromBuild paid on every synth.
//
// DIGEST PIN: The digest below must match the base image used by the `uv_python_lambda` CDK
// bundling image in the aws-news/backend repo. Pinning by digest guarantees the pre-pull is a
// cache hit at synth time — Docker skips the network round-trip when the manifest is already
// local. A digest MISMATCH is benign: the snapshot will simply contain a different layer than
// the synth expects, and cdk synth will pull its required digest fresh, just as it did before
// this prewarm. Mismatches waste snapshot space but never break builds.
// Update this constant whenever aws-news/backend bumps its SAM base image.
const SAM_BASE_IMAGE = 'public.ecr.aws/sam/build-python3.13@sha256:caa464dc2628d5e9e87936142b571d3cbd3c5cc3a64cde9471963bfa5c54d2c8';

// The uv version to pre-bake. Must match [tool.uv] required-version in aws-news/backend's
// pyproject.toml (currently 0.11.21). A VERSION MISMATCH is benign: CDK synth will build
// its own pinned version (~30s), which is no worse than before this prewarm. It never breaks
// builds. Update this when aws-news/backend bumps its required-version. Mirrors the SAM-digest
// drift note above.
const UV_VERSION = '0.11.21';

// The tag CDK passes as --build-arg IMAGE when building the uv bundling image. Building FROM
// this tag resolves locally to the already-pulled SAM_BASE_IMAGE digest above, giving the same
// parent image ID that CDK's DockerImage.fromBuild uses — ensuring the layer cache key matches.
const BUNDLING_IMAGE_REF = 'public.ecr.aws/sam/build-python3.13:latest';

// Vendored verbatim from uv_python_lambda@0.0.7/resources/Dockerfile.
// DRIFT RISK: If uv_python_lambda bumps its Dockerfile (new layers, different RUN) this copy
// diverges and the prebaked layer may not match CDK's build — producing a cache miss instead
// of the expected DONE 0.0s. A mismatch is benign: the synth re-runs the ~30s build rather
// than getting a cache hit. Update this when upgrading uv_python_lambda in aws-news/backend.
const UV_BUNDLING_DOCKERFILE = [
  'ARG PYTHON_VERSION=3.7',
  'ARG IMAGE=public.ecr.aws/sam/build-python${PYTHON_VERSION}',
  'FROM $IMAGE',
  'ARG PIP_INDEX_URL',
  'ARG PIP_EXTRA_INDEX_URL',
  'ARG HTTPS_PROXY',
  'ARG UV_VERSION=0.4.20',
  'ENV PIP_CACHE_DIR=/tmp/pip-cache',
  'ENV UV_CACHE_DIR=/tmp/uv-cache',
  'RUN mkdir /tmp/pip-cache && \\',
  '    chmod -R 777 /tmp/pip-cache && \\',
  '    pip install uv==$UV_VERSION && \\',
  '    rm -rf /tmp/pip-cache/*',
  'CMD [ "python" ]',
].join('\n') + '\n';

// 'pending' while prewarm is in flight, 'done' on success, 'failed' on error/timeout.
// HAS_DOCKER=false: pre-set to 'done' so the no-docker flavor is completely unaffected and
// /ready returns 200 immediately without waiting for a prewarm that would never start.
let prewarmState = HAS_DOCKER ? 'pending' : 'done'; // 'pending' | 'done' | 'failed'

// PREWARM_DEADLINE_MS is applied as the timeout ceiling for each step (pull, then build).
// Total prewarm budget is bounded by: DOCKER_READY_DEADLINE_MS (50s) + pull (~24s) + build
// (~40s emulated arm64) ≈ 114s. PREWARM_DEADLINE_MS gives ample headroom per step.
// DOCKER_READY_DEADLINE_MS + PREWARM_DEADLINE_MS must fit within readyTimeoutInSeconds
// configured in scripts/build-microvm-image.ts (currently 240s = 240_000ms):
//   50s (dockerd) + 160s (prewarm budget per step) = 210s < 240s — 30s headroom.
const PREWARM_DEADLINE_MS = 160_000;

// Sequentially: pulls SAM_BASE_IMAGE, then builds the uv bundling image from the vendored
// Dockerfile. Called only after dockerd is ready. Both steps run as best-effort:
//   • Pull failure  → prewarmState='failed'; cdk synth pulls SAM fresh (~24s).
//   • Build failure → prewarmState='failed'; cdk synth builds uv fresh (~30s).
//   • Build success → prewarmState='done'; both layers pre-warmed in snapshot.
// /ready returns 200 regardless — a prewarm failure never blocks jobs.
function prewarmDockerImages() {
  const start = Date.now();

  // Write vendored Dockerfile to a temp dir so `docker build` has a build context.
  const uvDockerfileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uv-prewarm-'));
  fs.writeFileSync(path.join(uvDockerfileDir, 'Dockerfile'), UV_BUNDLING_DOCKERFILE);

  console.log(`Prewarming SAM base image: ${SAM_BASE_IMAGE}`);
  execFile(
    'docker',
    ['pull', SAM_BASE_IMAGE],
    { timeout: PREWARM_DEADLINE_MS },
    (pullErr) => {
      if (pullErr) {
        prewarmState = 'failed';
        console.error(
          `SAM base image prewarm FAILED (pull) after ${Date.now() - start}ms — cdk synth will pull fresh.`,
          pullErr.message,
        );
        return;
      }

      // Pull succeeded — build the uv bundling image using the vendored Dockerfile.
      // --platform linux/arm64 matches Architecture.ARM_64 that CDK uses for Lambda functions.
      // --build-arg IMAGE uses the tag (not the digest) so Docker resolves it to the already-
      // pulled local manifest, ensuring the same parent image ID as CDK's DockerImage.fromBuild.
      const pullMs = Date.now() - start;
      console.log(`SAM base image pull complete (${pullMs}ms). Building uv bundling image (uv==${UV_VERSION})...`);
      execFile(
        'docker',
        [
          'build',
          '--platform', 'linux/arm64',
          '--build-arg', `IMAGE=${BUNDLING_IMAGE_REF}`,
          '--build-arg', `UV_VERSION=${UV_VERSION}`,
          '-t', `orchestrator-uv-prewarm:${UV_VERSION}`,
          uvDockerfileDir,
        ],
        { timeout: PREWARM_DEADLINE_MS },
        (buildErr) => {
          if (buildErr) {
            prewarmState = 'failed';
            console.error(
              `uv bundling image prewarm FAILED (build) after ${Date.now() - start}ms — cdk synth will build fresh.`,
              buildErr.message,
            );
          } else {
            prewarmState = 'done';
            console.log(`uv bundling image prewarm complete (${Date.now() - start}ms). Snapshot warmed with SAM pull + uv build.`);
          }
        },
      );
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
