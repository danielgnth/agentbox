# syntax=docker/dockerfile:1
# Overlay recipe: everything is installed under /opt in a build stage and
# copied onto `scratch`, so the mixin lands on any glibc workload and never
# touches the workload's package database or /home/agent.

FROM ubuntu:24.04 AS build
ARG TARGETARCH
ARG NODE_MAJOR
ARG JAVA_MAJOR
ARG RUST_TOOLCHAIN
SHELL ["/bin/bash", "-euo", "pipefail", "-c"]

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl xz-utils unzip tar gzip \
 && rm -rf /var/lib/apt/lists/*

# Node.js: latest release of the requested major line, checksum-verified.
RUN arch=$([ "$TARGETARCH" = arm64 ] && echo arm64 || echo x64); \
    base="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"; \
    sums=$(curl -fsSL "$base/SHASUMS256.txt"); \
    file=$(awk -v f="linux-${arch}.tar.xz" 'index($2, f) && $2 ~ /^node-v/ {print $2}' <<<"$sums"); \
    [ -n "$file" ]; \
    curl -fsSLO "$base/$file"; \
    grep " ${file}\$" <<<"$sums" | sha256sum -c -; \
    mkdir -p /opt/node && tar -xJf "$file" -C /opt/node --strip-components=1; \
    /opt/node/bin/node --version

# bun
RUN curl -fsSL https://bun.sh/install | BUN_INSTALL=/opt/bun bash; \
    /opt/bun/bin/bun --version

# uv / uvx
RUN curl -LsSf https://astral.sh/uv/install.sh \
      | env UV_INSTALL_DIR=/opt/uv/bin UV_NO_MODIFY_PATH=1 sh; \
    /opt/uv/bin/uv --version

# Rust (rustup). Agent-owned below, so rustup/cargo can install more.
ENV RUSTUP_HOME=/opt/rust/rustup CARGO_HOME=/opt/rust/cargo
RUN curl --proto '=https' --tlsv1.2 -fsSL https://sh.rustup.rs \
      | sh -s -- -y --no-modify-path --profile minimal \
          --default-toolchain "$RUST_TOOLCHAIN" -c rustfmt,clippy,rust-analyzer; \
    /opt/rust/cargo/bin/cargo --version

# Temurin JDK (latest GA build of the requested feature release).
RUN arch=$([ "$TARGETARCH" = arm64 ] && echo aarch64 || echo x64); \
    curl -fsSL -o /tmp/jdk.tar.gz \
      "https://api.adoptium.net/v3/binary/latest/${JAVA_MAJOR}/ga/linux/${arch}/jdk/hotspot/normal/eclipse"; \
    mkdir -p /opt/java && tar -xzf /tmp/jdk.tar.gz -C /opt/java --strip-components=1; \
    /opt/java/bin/java -version

# mise
RUN curl -fsSL https://mise.run | MISE_INSTALL_PATH=/opt/mise/bin/mise sh; \
    /opt/mise/bin/mise --version

# Stage the overlay. Root owns /opt and /etc; the agent (uid 1000) owns the
# toolchain trees it is expected to extend (npm -g, rustup, bun add -g).
RUN mkdir -p /out/opt /out/etc/profile.d \
 && cp -a /opt/node /opt/bun /opt/uv /opt/rust /opt/java /opt/mise /out/opt/ \
 && chown -R 1000:1000 /out/opt/node /out/opt/bun /out/opt/rust \
 && printf '%s\n' \
      '# agentbox toolchains (login shells; non-login shells get PATH from the image)' \
      'export JAVA_HOME="${JAVA_HOME:-/opt/java}"' \
      > /out/etc/profile.d/agentbox-toolchains.sh

FROM scratch
COPY --from=build /out/ /
# Only this kit sets these, so image ENV is safe (no merge conflicts).
ENV RUSTUP_HOME=/opt/rust/rustup \
    CARGO_HOME=/opt/rust/cargo \
    BUN_INSTALL=/opt/bun
# PATH merges by appending these elements to the workload's PATH.
ENV PATH=/opt/node/bin:/opt/bun/bin:/opt/uv/bin:/opt/rust/cargo/bin:/opt/java/bin:/opt/mise/bin
