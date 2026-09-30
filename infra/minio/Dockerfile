# Reproducible MinIO server + mc client image built from official upstream source.
#
# Upstream (archived AGPLv3 community edition, source-only distribution):
#   https://github.com/minio/minio @ RELEASE.2025-10-15T17-29-55Z
#     commit 9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a  (Security/CVE release)
#   https://github.com/minio/mc    @ RELEASE.2025-08-13T08-35-41Z
#     commit 7394ce0dd2a80935aded936b09fa12cbb3cb8096
#
# Trust model (D-016): organization-built from pinned official source commits;
# not a third-party prebuilt mirror. Floating latest/main/master is forbidden.
#
# Base images are pull-pinned by digest below.

ARG GOLANG_IMAGE=golang:1.24.8-alpine@sha256:3d78beb141d98f42337f1252ecf2a5f20374109929a4c3f6817f9e4179cc0ae5
ARG RUNTIME_IMAGE=alpine:3.22@sha256:5291449c3df73caf6ed85e649dec1b9e818b39a5d8c871e97afc13e9cd5e8fa8

FROM ${GOLANG_IMAGE} AS minio-build
ARG MINIO_VERSION=RELEASE.2025-10-15T17-29-55Z
ARG MINIO_COMMIT=9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a
RUN apk add --no-cache git make bash perl
WORKDIR /src
RUN git clone --filter=blob:none --branch "${MINIO_VERSION}" \
      https://github.com/minio/minio.git . \
 && test "$(git rev-parse HEAD)" = "${MINIO_COMMIT}"
ENV CGO_ENABLED=0
# MINIO_RELEASE brands the binary as RELEASE.* (matches upstream tag) instead of DEVELOPMENT.*
ENV MINIO_RELEASE=RELEASE
RUN make build \
 && ./minio --version

FROM ${GOLANG_IMAGE} AS mc-build
ARG MC_VERSION=RELEASE.2025-08-13T08-35-41Z
ARG MC_COMMIT=7394ce0dd2a80935aded936b09fa12cbb3cb8096
RUN apk add --no-cache git make bash perl
WORKDIR /src
RUN git clone --filter=blob:none --branch "${MC_VERSION}" \
      https://github.com/minio/mc.git . \
 && test "$(git rev-parse HEAD)" = "${MC_COMMIT}"
ENV CGO_ENABLED=0
ENV MC_RELEASE=RELEASE
RUN make build \
 && ./mc --version

FROM ${RUNTIME_IMAGE}
# Root matches historical MinIO container volume/permission semantics used by Compose,
# backup/restore helpers, and minio-init (mc). Do not switch to a non-root user without
# verifying /data ownership and script entrypoints.
RUN apk add --no-cache ca-certificates curl
COPY --from=minio-build /src/minio /usr/bin/minio
COPY --from=mc-build /src/mc /usr/bin/mc
RUN chmod 755 /usr/bin/minio /usr/bin/mc \
 && minio --version \
 && mc --version
EXPOSE 9000 9001
VOLUME ["/data"]
ENTRYPOINT ["minio"]
CMD ["server", "/data", "--console-address", ":9001"]
