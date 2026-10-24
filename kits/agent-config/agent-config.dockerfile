# syntax=docker/dockerfile:1
# Overlay recipe: gh CLI, the git hook dispatcher and Claude managed settings.

FROM ubuntu:24.04 AS build
ARG TARGETARCH
SHELL ["/bin/bash", "-euo", "pipefail", "-c"]

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl tar gzip \
 && rm -rf /var/lib/apt/lists/*

# gh CLI: latest release, checksum-verified. Used as the git credential
# helper; the proxy swaps its GH_TOKEN sentinel for the real App token.
RUN v=$(curl -fsSL https://api.github.com/repos/cli/cli/releases/latest \
          | sed -nE 's/.*"tag_name": *"v([^"]+)".*/\1/p' | head -1); \
    f="gh_${v}_linux_${TARGETARCH}.tar.gz"; \
    cd /tmp && curl -fsSLO "https://github.com/cli/cli/releases/download/v${v}/${f}"; \
    curl -fsSL "https://github.com/cli/cli/releases/download/v${v}/gh_${v}_checksums.txt" \
      | grep " ${f}\$" | sha256sum -c -; \
    tar -xzf "$f"; \
    install -D -m 0755 "gh_${v}_linux_${TARGETARCH}/bin/gh" /out/usr/local/bin/gh

COPY files/git-hooks/dispatch /out/usr/local/share/agentbox/git-hooks/dispatch
COPY files/managed-settings.json /out/etc/claude-code/managed-settings.json
RUN chmod 0755 /out/usr/local/share/agentbox/git-hooks/dispatch \
 && chmod 0644 /out/etc/claude-code/managed-settings.json \
 && cd /out/usr/local/share/agentbox/git-hooks \
 && for h in applypatch-msg pre-applypatch post-applypatch pre-commit \
             pre-merge-commit prepare-commit-msg commit-msg post-commit \
             pre-rebase post-checkout post-merge pre-push post-rewrite; do \
      ln -s dispatch "$h"; \
    done

FROM scratch
COPY --from=build /out/ /
# git-ai installs per user into ~/.git-ai (see the install hook).
ENV PATH=/home/agent/.git-ai/bin
