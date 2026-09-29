# Budget Manager

Lightweight expense manager.

## Recommended architecture

This repo includes a safer architecture split:

- Frontend can be hosted on GitHub Pages
- API runs in a container and keeps GitHub credentials in environment variables
- Data can live in a GitHub private repo
- The browser does not hold the GitHub PAT directly

## Repo layout

- `api/server.js` – backend API that reads/writes the GitHub-hosted budget file
- `api/.env.example` – environment variables for the API
- `api/Dockerfile` – container build for the API
- `docker-compose.yml` – local container setup

## Why this is safer

The browser should not contain a GitHub PAT. The backend should fetch and save the file using a token stored only on the server.

## Local setup

1. Copy `api/.env.example` to `api/.env`
2. Fill in your actual GitHub values and set a strong `API_KEY`
3. Run:

   docker-compose up --build

4. Check health:

   http://localhost:3001/health

5. When calling the API from the frontend, send the `x-api-key` header with the same value as `API_KEY`.

## Deploying the API

Use a free Docker hosting provider such as Render or Railway, or a small VM with Docker.

For production, keep these values in the platform secret manager or container environment variables only.

## Important note

The existing single-file browser app still contains the old direct GitHub token pattern. Before public deployment, move the GitHub sync logic to the API and ensure the frontend calls the backend API instead of hitting GitHub directly.
