# Budget Manager

Lightweight expense manager.

## Recommended architecture

This repo includes a safer architecture split:

- Frontend can be hosted on GitHub Pages
- API runs in a container and keeps GitHub credentials in environment variables
- Data can live in a GitHub private repo
- The browser does not hold the GitHub PAT directly

## Repo layout

- `api/server.js` � backend API that reads/writes the GitHub-hosted budget file
- `api/.env.example` � environment variables for the API
- `api/Dockerfile` � container build for the API
- `docker-compose.yml` � local container setup

## Security model

The browser signs in with the app password and keeps a short-lived session token in memory. The Render API validates the session and uses the GitHub token stored in Render's environment. Neither secret is embedded in the public HTML.

This is a shared-password personal deployment, not a multi-user authentication system. Do not reuse the GitHub password as `APP_PASSWORD`.

## Local container

Copy `api/.env.example` to `api/.env`, fill in local values, then run `docker compose up --build` from the repository root. Check `http://localhost:3001/health` for the health response.

## Render and GitHub Pages

The frontend uses `https://plansurf-budget.onrender.com` as its API and expects the Pages origin `https://beawart.github.io`.

In Render, set these environment variables on the Web Service:

- `APP_PASSWORD`: a long, unique app password used in the sync dialog. This is shared personal-app access, not a multi-user account system.
- `SESSION_SECRET`: random signing secret, at least 32 random bytes.
- `GITHUB_TOKEN`: fine-grained token with Contents read/write access only to `beawart/plansurf-data`.
- `GITHUB_OWNER=beawart`
- `GITHUB_REPO=plansurf-data`
- `GITHUB_PATH=plansurf.budget-data.json`
- `GITHUB_BRANCH=main`
- `CORS_ORIGIN=https://beawart.github.io` (origin only; no path)

Remove the old `API_KEY` variable from Render. Never put `APP_PASSWORD`, `SESSION_SECRET`, or `GITHUB_TOKEN` in this repository or the HTML. Redeploy after changing Render variables.

Generate `SESSION_SECRET` locally in PowerShell and paste it directly into Render's environment settings:

```powershell
$bytes = New-Object byte[] 48
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
$rng.GetBytes($bytes)
[Convert]::ToBase64String($bytes)
$rng.Dispose()
```

In GitHub **Settings > Pages**, publish the `main` branch from `/ (root)`. Open the Pages URL, open the cloud/sync control, enter the Render API URL and `APP_PASSWORD`, sign in, then use **Pull latest** or **Save local data**. The 12-hour session is held in page memory only; reloading requires signing in again. The GitHub PAT stays on Render.

The free-form `file://` page origin is intentionally not allowed. For local browser testing, serve the page over HTTP and set `CORS_ORIGIN` to that server's exact origin.

## Local container

Copy `api/.env.example` to `api/.env`, fill in local values, then run `docker compose up --build` from the repository root.
