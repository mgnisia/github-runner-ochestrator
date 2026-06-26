FROM ubuntu:24.04

ARG DEBIAN_FRONTEND=noninteractive

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      ca-certificates curl gnupg tar gzip net-tools && \
    rm -rf /var/lib/apt/lists/*

# Node.js 22 (NodeSource — Ubuntu's repos only ship Node 18)
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && \
    apt-get install -y --no-install-recommends nodejs && \
    rm -rf /var/lib/apt/lists/*

ENV RUNNER_VERSION=2.335.1
WORKDIR /actions-runner

RUN curl -fsSL -O "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-linux-arm64-${RUNNER_VERSION}.tar.gz" && \
    tar xzf "actions-runner-linux-arm64-${RUNNER_VERSION}.tar.gz" && \
    rm "actions-runner-linux-arm64-${RUNNER_VERSION}.tar.gz" && \
    ./bin/installdependencies.sh && \
    rm -rf /var/lib/apt/lists/*

# Pre-populate the actions/setup-python tool cache with CPython so jobs skip the download.
# AGENT_TOOLSDIRECTORY is honored both by python-versions' setup.sh (at build time, below)
# and by the runner at job time, where it is exposed to jobs as RUNNER_TOOL_CACHE.
ENV AGENT_TOOLSDIRECTORY=/opt/hostedtoolcache
ARG PYTHON_VERSION=3.13.14
ARG PYTHON_PLATFORM_VERSION=24.04
ARG PYTHON_ARCH=arm64

# Shared-library runtime deps for the prebuilt CPython stdlib (ssl/ffi/zlib/uuid are already in
# the base image; these cover sqlite3, bz2, lzma, readline, curses and gdbm).
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      libsqlite3-0 libbz2-1.0 liblzma5 libreadline8t64 libncursesw6 libgdbm6t64 libgdbm-compat4t64 && \
    rm -rf /var/lib/apt/lists/*

# Resolve the download URL from the python-versions manifest (avoids hardcoding the release id),
# extract, and run the bundled setup.sh, which installs into $AGENT_TOOLSDIRECTORY, creates the
# python symlinks, upgrades pip, and writes the ${PYTHON_ARCH}.complete marker setup-python checks.
RUN set -eux; \
    url="$(curl -fsSL https://raw.githubusercontent.com/actions/python-versions/main/versions-manifest.json \
      | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const m=JSON.parse(d);const[v,pv,a]=process.argv.slice(1);const e=m.find(x=>x.version===v);if(!e){console.error("version "+v+" not in manifest");process.exit(1)}const f=e.files.find(f=>f.platform==="linux"&&f.platform_version===pv&&f.arch===a);if(!f){console.error("no matching linux build for "+v+" "+pv+" "+a);process.exit(1)}process.stdout.write(f.download_url)})' "$PYTHON_VERSION" "$PYTHON_PLATFORM_VERSION" "$PYTHON_ARCH")"; \
    echo "Downloading $url"; \
    mkdir -p /tmp/py; \
    curl -fsSL "$url" -o /tmp/py/python.tar.gz; \
    tar xzf /tmp/py/python.tar.gz -C /tmp/py; \
    ( cd /tmp/py && bash ./setup.sh ); \
    rm -rf /tmp/py

COPY entrypoint.sh .
RUN chmod +x entrypoint.sh

# Install SDK dependencies before copying app.js so this layer caches independently
COPY package.json .
RUN npm install --omit=dev --no-audit --no-fund

COPY app.js .

# Required to run the runner as root (default in containers)
ENV RUNNER_ALLOW_RUNASROOT=1

EXPOSE 8080 9000
CMD ["node", "app.js"]
