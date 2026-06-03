# Deprecated package path

Moltbook outreach runs from the monorepo workspace package:

- Source: [`../outreach-agent/`](../outreach-agent/)
- Deploy: `npm run outreach:deploy:rsync` or `npm run analytics:deploy:rsync` from repo root
- Env: repo root [`.env`](../.env) or [`../outreach-agent/.env`](../outreach-agent/.env)

This directory is kept only for legacy `.env` paths during migration. Do not add new code here.
