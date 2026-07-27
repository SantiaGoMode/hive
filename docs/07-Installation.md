---
layout: guide
title: Installation
description: Install a signed desktop release on macOS or Linux, or run Hive from source.
permalink: /docs/installation/
section: Start here
previous_url: /docs/
previous_label: Documentation home
next_url: /docs/getting-started/
next_label: Getting started
---

## Desktop app

The desktop app is the recommended path. Download the latest artifact from [GitHub Releases](https://github.com/SantiaGoMode/hive/releases).

| Platform | Package | Notes |
|---|---|---|
| macOS Apple silicon | ARM64 `.dmg` | Developer ID signed and notarized |
| macOS Intel | x64 `.dmg` | Developer ID signed and notarized |
| Linux AMD64 | `.deb` | Recommended on Debian and Ubuntu |
| Linux ARM64 | `.deb` | Recommended on ARM Debian and Ubuntu |
| Linux | `.AppImage` | Portable alternative; some systems require FUSE 2 |

Windows installers are not currently published. Windows packaging exists for local builds, but a public release waits on Authenticode signing.

### Verify the download

Each release includes `SHA256SUMS.txt`. Download it beside the installer, then verify:

```bash
shasum -a 256 -c SHA256SUMS.txt
```

On Linux, use `sha256sum -c SHA256SUMS.txt` if `shasum` is unavailable. The checksum file covers multiple artifacts, so verification can report missing files for packages you did not download; your selected artifact must report `OK`.

Do not bypass macOS quarantine if Gatekeeper rejects a production build. Confirm the checksum and open an issue with the version and diagnostic report.

## Run from source

You need Node.js 22 or newer. Ollama is recommended for local models; Docker is optional but required for container sandboxes and the LiteLLM gateway.

```bash
git clone https://github.com/SantiaGoMode/hive.git
cd hive
npm install
npm install --prefix client
```

For development with hot reload:

```bash
npm run dev
```

Open `http://localhost:5173`.

For a production build:

```bash
npm run build
npm start
```

Open `http://localhost:3001`.

## Optional command-line dependencies

Hive checks for these during setup and exposes only the capabilities that are available:

- `ollama` for local inference
- Docker for isolated sandboxes and the optional gateway
- `git` and `gh` for repository and GitHub work
- `npx` and `uvx` for MCP servers distributed through Node or Python

Continue to [Getting started]({{ '/docs/getting-started/' | relative_url }}) for the first-run checklist.
