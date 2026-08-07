# Full dist overlay image

Use this deployment-only Dockerfile after `pnpm build` when the source and the
pinned base image use the same dependency lockfile, but an amd64 image must be
published from Apple Silicon without cross-compiling the native Go/Rust
modules.

```bash
pnpm build
docker buildx build \
  --platform linux/amd64 \
  --file docker/full-dist-overlay/Dockerfile \
  --build-context dist-context=./dist \
  --build-arg GIT_SHA="$(git rev-parse HEAD)" \
  --tag example/firecrawl:latest \
  --push .
```

The full compiled `dist` tree is copied, not a string-level runtime patch.
Always run TypeScript build and targeted tests before publishing. Update the
pinned base whenever dependencies or native modules change.
