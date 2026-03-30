# Starter Grant Service

Small HTTP service that issues starter-grant challenges and funds one-time native-token claims.

## Local Docker Compose

Create a runtime env file:

```bash
cp starter-grant-service/.env.example starter-grant-service/.env
```

Then start the service:

```bash
npm run starter-grant:docker:up
```

Stop it:

```bash
npm run starter-grant:docker:down
```

The container stores its file-backed state in `starter-grant-service/.data/`.

## Rsync Deploy

The package includes `starter-grant-service/deploy-rsync.sh`, which syncs the package directory to a remote host and runs `docker compose up -d --build`.

Required deploy env vars:

```bash
export STARTER_GRANT_DEPLOY_HOST=your.server
export STARTER_GRANT_DEPLOY_USER=deploy
export STARTER_GRANT_DEPLOY_PATH=/srv/coti/starter-grant-service
```

Optional deploy env vars:

```bash
export STARTER_GRANT_DEPLOY_PORT=22
export STARTER_GRANT_DEPLOY_ENV_FILE=/path/to/starter-grant-service.env
export STARTER_GRANT_DEPLOY_DELETE=1
export STARTER_GRANT_PUBLIC_URL=https://grants.example.com
# or derive it:
export STARTER_GRANT_PUBLIC_HOST=grants.example.com
export STARTER_GRANT_PUBLIC_SCHEME=https
export STARTER_GRANT_PUBLIC_PORT=443
```

Run the deploy:

```bash
npm run starter-grant:deploy:rsync
```

After a successful deploy, the script prints:

```bash
STARTER_GRANT_SERVICE_URL=...
```

That is the value you can drop directly into the SDK or MCP env.

The remote target should have:

- Docker with `docker compose`
- a writable deploy path
- a valid `.env` file synced or created at `<deploy-path>/.env`

The deploy script excludes local build outputs, `node_modules`, `.data`, and `.env`, then optionally syncs the env file separately.
