# Docker and Railway

The image runs the hosted multiplayer service, including its game workers. Node and production dependencies are included; only Docker with Compose is needed on the host. Runtime state belongs in `/data`, outside the image. Run one replica with exclusive ownership of its volume.

## Start from a pulled repo

```sh
cp .env.example .env
# Edit .env and supply your server's JEV_API_KEY.
docker compose up -d --build
docker compose ps
docker compose logs game
```

Open http://localhost:3100. The logs include the host-page URL and its token; keep that URL private. `HOST_REMOTE=1` enables token-authenticated host access through the container network. Participants enter their own Jev keys in the game. Starting the server and checking `/health` do not call Jev; starting a game does.

Compose reads the repo-root `.env`; it does not load the development `../.env`. Shell variables override `.env`. Secrets are passed at runtime and excluded from the image. The image runs as the unprivileged `node` user; a new Compose named volume inherits `/data`'s ownership.

For a VPS, put an HTTPS reverse proxy in front of port 3100. The default binding is local to the host. Set `DOCKER_BIND_IP=0.0.0.0` only when deliberately exposing the port. `DOCKER_PORT` changes the host port without changing the container port.

## Update, stop, and check

```sh
git pull --ff-only
docker compose up -d --build
curl --fail http://localhost:3100/health
docker compose logs --tail=50 game
docker compose down
```

Updates and `down` preserve the named volume. **Do not use `docker compose down -v` unless you intend to delete saved games and settings.** After a restart, active games restore paused and participants must re-enter their keys. Settings revisions persist in the volume; the bundled `central-config.yaml` seeds a new store only.

For backups, stop the service and copy the complete volume using your Docker host's backup tooling, then restart it. See [operations](OPERATIONS.md) for recovery and data handling.

## Build or run without Compose

```sh
docker build -t jev-dungeon:local .
docker volume create jev-dungeon-data
docker run -d --name jev-dungeon --init --restart unless-stopped \
  --stop-timeout 30 -p 127.0.0.1:3100:3100 \
  --env-file .env -e HOST_REMOTE=1 \
  -v jev-dungeon-data:/data jev-dungeon:local
```

## Railway

1. Create a service from the Docker image `ghcr.io/jakubklas/jev-dungeon:latest` after the first main-branch workflow succeeds. For testing this deployment branch before merging, use `ghcr.io/jakubklas/jev-dungeon:feat-docker-deployment`. Leave the start-command override empty to use the image's command. Set the healthcheck path to `/health` and the restart policy to On Failure in the service settings.
2. Attach a persistent volume mounted at `/data`.
3. Set `JEV_API_KEY`, `HOST_REMOTE=1`, and `RAILWAY_RUN_UID=0`. Railway volumes are mounted as root; this override permits writing to them. Optionally set `HOST_TOKEN` to a long random value for a stable host URL.
4. Keep one replica and disable serverless sleeping so game workers stay running. Use the same region for the service and volume.
5. Generate a public domain, targeting Railway's supplied `PORT` (or 3100 if you explicitly keep that port). The image binds to `0.0.0.0` and honors `PORT`.
6. Check `/health` and retrieve the host URL from deployment logs. Enable volume backups.

Railway pulls the published image; GitHub Actions builds it. Set variables and attach storage in Railway itself. Enable Image Auto Updates in Railway and select a maintenance window outside your usual game sessions. Railway periodically checks GHCR and redeploys when the configured tag's digest changes; updates are not immediate on every Git push. A deployment restarts the process and pauses active games.

For this project, use a public GHCR package so Railway can pull without registry credentials. GHCR packages are private on first publication, even for a public repository: after the first workflow run, open the package's settings and change its visibility to public. Repository visibility and package visibility are separate; the repo itself does not need to be public for anonymous image pulls. No registry credential is needed in Actions: the workflow uses its scoped `GITHUB_TOKEN`.

## Automatic GHCR builds

[The workflow](../.github/workflows/container.yml) builds on every branch push and supports manual runs. It publishes Linux AMD64 images, matching Railway's runtime, after a stubbed startup/health/shutdown check. Builds cache dependency layers to reduce repeat work.

Published tags:

- `latest`: only pushes to `main`, for production.
- `main`, `feat-docker-deployment`, etc.: the branch name converted to a valid Docker tag, for branch testing.
- `sha-<full-commit-sha>`: a specific revision for rollback.

Feature branches never overwrite production's `latest`. To roll back, change Railway's image reference to a previously published SHA tag. Pinned SHA tags do not follow later pushes. A failed build or smoke check leaves the published tags unchanged.

The workflow must be committed and pushed before GitHub can run it. Check the repository's Actions tab, then its Packages link for the published image. If a package with this name already exists, grant this repository Actions write access in the package settings. Keep old SHA tags you might need for recovery; untagged build versions can be cleaned up separately.

References: [Railway image auto updates](https://docs.railway.com/deployments/image-auto-updates), [volume permissions](https://docs.railway.com/volumes#permissions), [GitHub Container Registry](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry).
