# Docker Compose

Run these commands from the repository root. Docker Engine with the Buildx and
Compose plugins (Compose 2.20+ for optional dependencies) is required; Node.js, pnpm, PostgreSQL and Redis are installed
in the images.

## Start and update

```sh
cp docker/.env.example .env
# Keep your existing config, or create an empty one:
test -f survev-config.hjson || printf '{}\n' > survev-config.hjson
```

Edit `.env`: set `PUBLIC_HOST` to your domain/IP (without scheme or port),
`WEB_PORT`, `GAME_PORT`, and `POSTGRES_PASSWORD`. Keep `COMPOSE_PROFILES=local`
for bundled PostgreSQL, migrations and Redis (add this line to older `.env` files).
Then start:

```sh
docker compose up -d --build --force-recreate
```

Open `http://PUBLIC_HOST:WEB_PORT`. Use the same command after changing code,
`.env` or application configuration. It rebuilds the images, regenerates configs
and restarts services, interrupting active matches. The web build deliberately
runs without cache so changes to its secret-mounted configuration take effect.

```sh
docker compose logs -f api game
docker compose down
```

Data and generated secrets remain in `data/` after `down`. Changing the password
in `.env` does not change the password of an already initialized PostgreSQL role.

## Application configuration

Use `survev-config.hjson`, the same file as for running without Docker. To use
another HJSON file, set `SURVEV_CONFIG` in `.env`. Docker does not modify the source
file. Configuration fields are described in [configType.ts](../configType.ts).

OAuth credentials, CAPTCHA, `passType`, regions and other existing settings go
in this file. Both servers and the client build read it; only public settings
are included in the client. Server secrets are kept out of image layers.
Existing client integration switches are listed in `.env.example`.

Container addresses are defaults: explicit HJSON settings take precedence,
including database connections, API URLs, listen ports and region addresses.
Use container-reachable addresses (`localhost` means the current container).
Generated role configs live in `data/config/`. Generated API/IP keys are retained
unless explicitly supplied in the source. Use the shared source for client-facing
settings so client and server agree. Move any settings previously edited directly
in generated role files into the shared source; only API-managed modes/theme/CAPTCHA
state and generated keys persist there.

| Setting | Default / how to change |
| --- | --- |
| API / game listen ports | 8000 / 8001; match `API_INTERNAL_PORT` / `GAME_INTERNAL_PORT` to explicit HJSON ports |
| Match range | `MATCH_PORT_START=9000`, `MATCH_PORT_END=9063`; also cover any explicit `firstGamePort` / `maxGames` |
| Website's API upstream | `API_UPSTREAM=api:8000`; change for a different API host or port |
| Redis | `REDIS_URL=redis://redis:6379`; set `cachingEnabled: false` in HJSON to disable caching |
| Persistent data | `DATA_DIR=./data`; separate directory for each deployment |

## Individual services and regions

Selecting a component starts only its dependencies. Game and bot require only
configuration; web can connect to an external API:

```sh
docker compose up -d --build --force-recreate game
docker compose up -d --build --force-recreate bot
docker compose up -d --build --force-recreate api web
```

For external PostgreSQL/Redis, clear `COMPOSE_PROFILES` in `.env`, supply the
existing `database` settings in HJSON and `REDIS_URL` in `.env`. Prepare the
configuration and, if the database is enabled, apply migrations before starting API:

```sh
docker compose run --rm configure
docker compose run --rm --no-deps migrate
docker compose up -d --build --force-recreate api web
```

For a game-only deployment, set `gameServer.apiServerUrl`, `gameServer.thisRegion`
and its public `regions` entry in HJSON. Supply the main deployment's API/IP keys.
Additional regions use another config and env file, project name, data directory
and published ports; no application changes are needed:

```sh
docker compose --env-file .env.eu -p eu up -d --build --force-recreate game
```

The main API/client config must list those regions. Explicit region addresses
are preserved, including for plain HTTP, and must be reachable from the API.
Compose adds an internal `game` address only when generating the default region.

## Development

The dev override runs the existing `pnpm dev` with source files mounted from the
host. Linux dependencies live in Docker volumes. It uses your HJSON directly,
without production configuration generation. For bundled PostgreSQL set
`database.host: "db"` and its password; set `vite.host: "0.0.0.0"` and normally
`vite.port: 3000`. For remote players, also set public `regions` addresses.

```sh
docker compose -f compose.yaml -f docker/compose.dev.yaml up --build dev
```

Open `http://localhost:3000`. Source and config changes use the project's existing
watchers (polling is enabled for VM bind mounts). `DEV_PORT` / `DEV_INTERNAL_PORT` set Vite's published/listen port mapping.
Stop production game first if it uses the same ports. For an external database,
apply migrations as above; for `database.enabled: false`, clear the local profile.

## Discord bot (optional)

Add these fields to the shared HJSON, keeping existing settings and secrets:

```hjson
discordGuildId: "YOUR_SERVER_ID"
discordRoleId: "YOUR_MODERATOR_ROLE_ID"
secrets: {
    DISCORD_CLIENT_ID: "YOUR_APPLICATION_ID"
    DISCORD_BOT_TOKEN: "YOUR_BOT_TOKEN"
}
```

Invite the application with the `bot` and `applications.commands` scopes. Start
with the profile, then register slash commands once (and after command changes):

```sh
docker compose --profile local --profile bot up -d --build --force-recreate
docker compose run --rm bot pnpm register-commands
docker compose logs -f bot
```

Alternatively set `COMPOSE_PROFILES=local,bot` in `.env` and use the normal
update command. For external services, enable only `bot`. Bot setup does not enable Discord
OAuth login; that also requires the OAuth secret and public HTTPS configuration.

## HTTPS / WSS (optional)

For TLS handled by this stack, put `fullchain.pem` and `privkey.pem` in
`data/certs/`. The game container's user (UID/GID 1000:1000) must be able to read
them. Add to the shared HJSON, replacing the domain and game port:

```hjson
oauthRedirectURI: "https://play.example.org"
regions: {
    local: { https: true, address: "play.example.org:8001", l10n: "index-local" }
}
gameServer: {
    ssl: { keyFile: "/certs/privkey.pem", certFile: "/certs/fullchain.pem" }
}
```

```sh
docker compose -f compose.yaml -f docker/compose.tls.yaml up -d --build --force-recreate
```

Use the same command for updates; add `--profile local --profile bot` to include the bot and local services.
The override mounts certificates read-only, enables HTTPS on port 443 and uses
the game's existing TLS support for game/match connections. `TLS_CERT_DIR` and
`WEB_TLS_PORT` can be changed in `.env`. Certificates must be trusted by clients
and the API; the public game address must also be reachable from the API container.

If an external proxy handles TLS, use the base Compose file and omit
`gameServer.ssl`; configure the proxy for the website and game/match connections.
Public URLs must still advertise HTTPS. No certificate mounts are needed then.
