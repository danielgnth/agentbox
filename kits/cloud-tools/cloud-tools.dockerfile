# syntax=docker/dockerfile:1
# Overlay recipe: static binaries into /usr/local/bin, gcloud into /opt.
# Versions resolve to the latest stable release at build time; rebuild the
# sandbox (agentbox up --recreate) to pick up new ones.

FROM ubuntu:24.04 AS build
ARG TARGETARCH
SHELL ["/bin/bash", "-euo", "pipefail", "-c"]

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl unzip tar gzip python3 \
 && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /out/usr/local/bin /out/opt

# Latest release tag of a GitHub repo, without the leading "v".
RUN printf '%s\n' '#!/bin/bash' 'set -euo pipefail' \
      'curl -fsSL "https://api.github.com/repos/$1/releases/latest" | sed -nE '"'"'s/.*"tag_name": *"v?([^"]+)".*/\1/p'"'"' | head -1' \
      > /usr/local/bin/gh-latest && chmod +x /usr/local/bin/gh-latest

# kubectl (checksum-verified)
RUN v=$(curl -fsSL https://dl.k8s.io/release/stable.txt); \
    url="https://dl.k8s.io/release/${v}/bin/linux/${TARGETARCH}/kubectl"; \
    curl -fsSLo /tmp/kubectl "$url"; \
    echo "$(curl -fsSL "$url.sha256")  /tmp/kubectl" | sha256sum -c -; \
    install -m 0755 /tmp/kubectl /out/usr/local/bin/kubectl

# helm
RUN v=$(gh-latest helm/helm); \
    curl -fsSL "https://get.helm.sh/helm-v${v}-linux-${TARGETARCH}.tar.gz" | tar -xz -C /tmp; \
    install -m 0755 "/tmp/linux-${TARGETARCH}/helm" /out/usr/local/bin/helm

# flux
RUN v=$(gh-latest fluxcd/flux2); \
    curl -fsSL "https://github.com/fluxcd/flux2/releases/download/v${v}/flux_${v}_linux_${TARGETARCH}.tar.gz" \
      | tar -xz -C /tmp flux; \
    install -m 0755 /tmp/flux /out/usr/local/bin/flux

# terraform (checksum-verified)
RUN v=$(curl -fsSL https://checkpoint-api.hashicorp.com/v1/check/terraform \
          | sed -nE 's/.*"current_version":"([^"]+)".*/\1/p'); \
    f="terraform_${v}_linux_${TARGETARCH}.zip"; \
    cd /tmp && curl -fsSLO "https://releases.hashicorp.com/terraform/${v}/${f}"; \
    curl -fsSL "https://releases.hashicorp.com/terraform/${v}/terraform_${v}_SHA256SUMS" \
      | grep " ${f}\$" | sha256sum -c -; \
    unzip -q "$f" terraform && install -m 0755 terraform /out/usr/local/bin/terraform

# tflint
RUN curl -fsSLo /tmp/tflint.zip \
      "https://github.com/terraform-linters/tflint/releases/latest/download/tflint_linux_${TARGETARCH}.zip"; \
    cd /tmp && unzip -q tflint.zip tflint && install -m 0755 tflint /out/usr/local/bin/tflint

# gcloud (Google's "rapid" channel tarball; arm64 is named "arm").
RUN arch=$([ "$TARGETARCH" = arm64 ] && echo arm || echo x86_64); \
    curl -fsSL "https://dl.google.com/dl/cloudsdk/channels/rapid/google-cloud-cli-linux-${arch}.tar.gz" \
      | tar -xz -C /opt; \
    /opt/google-cloud-sdk/install.sh --quiet --usage-reporting=false \
      --path-update=false --command-completion=false; \
    rm -rf /opt/google-cloud-sdk/.install/.backup; \
    cp -a /opt/google-cloud-sdk /out/opt/

FROM scratch
COPY --from=build /out/ /
ENV CLOUDSDK_CORE_DISABLE_PROMPTS=1
ENV PATH=/opt/google-cloud-sdk/bin
