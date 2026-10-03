FROM ubuntu:24.04

ARG CLAUDE_VERSION=2.1.288
ARG NODE_VERSION=22.23.3
ARG BUN_VERSION=1.4.2
ARG TYPESCRIPT_VERSION=7.0.2

ENV DEBIAN_FRONTEND=noninteractive \
    DISABLE_AUTOUPDATER=1 \
    HOME=/home/bench \
    PATH=/home/bench/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git jq strace unzip xz-utils procps python3 \
 && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" -o /tmp/node.tar.xz \
 && curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" | grep " node-v${NODE_VERSION}-linux-x64.tar.xz\$" > /tmp/node.sha \
 && sed -i "s# node-v.*# /tmp/node.tar.xz#" /tmp/node.sha && sha256sum -c /tmp/node.sha \
 && tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 \
 && rm -f /tmp/node.tar.xz /tmp/node.sha

RUN curl -fsSL "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-x64.zip" -o /tmp/bun.zip \
 && curl -fsSL "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/SHASUMS256.txt" | grep " bun-linux-x64.zip\$" > /tmp/bun.sha \
 && sed -i "s# bun-linux-x64.zip# /tmp/bun.zip#" /tmp/bun.sha && sha256sum -c /tmp/bun.sha \
 && unzip -q /tmp/bun.zip -d /tmp/bun && install -m 0755 /tmp/bun/bun-linux-x64/bun /usr/local/bin/bun \
 && install -D -m 0755 /tmp/bun/bun-linux-x64/bun /opt/driver/bun \
 && ln -s bun /usr/local/bin/bunx && rm -rf /tmp/bun /tmp/bun.zip /tmp/bun.sha

RUN HOME=/root npm install -g typescript@${TYPESCRIPT_VERSION} && tsc --version

RUN userdel -r ubuntu 2>/dev/null; useradd -m -u 1000 -s /bin/bash bench \
 && mkdir -p /cfg /work /out && chown bench:bench /cfg /work /out

USER bench
WORKDIR /home/bench
RUN curl -fsSL https://claude.ai/install.sh | bash -s "${CLAUDE_VERSION}" \
 && claude --version \
 && git config --global user.email bench@example.invalid \
 && git config --global user.name bench \
 && git config --global init.defaultBranch main
