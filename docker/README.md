# Docker Compose

Run from the repository root with Docker Engine and the Docker Compose plugin:

```sh
docker compose up -d --build
```

Open **http://localhost:8080**. Node.js, pnpm, PostgreSQL and Redis do not need
to be installed on the host. The first build downloads dependencies and builds
the client assets and server.

### Building with Podman

The same Dockerfile can be built directly without a Compose provider:

```sh
podman build --target server -f docker/Dockerfile -t survev-server:local .
podman build --target web -f docker/Dockerfile -t survev-web:local .
```

On small VMs, parallel atlas rendering can run out of memory. To reduce the
number of atlas workers without changing game code, pass
`--build-arg CLIENT_BUILD_CPUSET=0-2` to the web build on a VM with CPUs 0–2
available. This makes the existing atlas builder choose one worker. The limit
uses process affinity inside the build and does not require a cgroup cpuset
controller. It does not affect running game containers. A 2 GiB VM still ran
out of memory on the largest atlas with one worker; the build succeeded with
an additional 4 GiB of temporary swap. Allow more memory or swap for builds.

Direct builds do not read `.env`; supply `--build-arg PUBLIC_HOST=your-host`
and `--build-arg WEB_PORT=8080` to the web build when changing the defaults.
To use `podman compose -f compose.yaml`, install a modern Compose provider
supporting `service_completed_successfully`; Compose 1.27.4 is too old.

## Playing from another computer

Before building, copy the example into the repository root:

```sh
cp docker/.env.example .env
```

Set `PUBLIC_HOST` to the server's LAN/public IPv4 address or DNS hostname
(without a scheme, path or port). Set `WEB_PORT` if port 8080 is unavailable.
Set `POSTGRES_PASSWORD` before the first start. Then run:

```sh
docker compose up -d --build
```

Players open `http://PUBLIC_HOST:WEB_PORT`. Allow inbound **TCP** on the web
port, **8001**, and **9000–9063**; forward these ports when hosting behind a
router. Each match has its own WebSocket port, as in the original server.
Game ports must keep their original numbers on the host.

The public address is compiled into the browser client. After changing
`PUBLIC_HOST` or `WEB_PORT`, run `docker compose up -d --build` again; restarting
containers alone does not rebuild the client.

The same configuration inputs (`PUBLIC_HOST`, `WEB_PORT`, `POSTGRES_PASSWORD`)
are included in the environment of `configure`, `migrate`, `api` and `game`.
This makes Compose recreate those containers when a value changes, so running
servers reload the generated configuration after configuration and migrations
complete. The application still reads its HJSON file; these environment values
also serve as Compose recreation triggers. Manual edits to HJSON files require
a restart of the affected server. Recreating the game server interrupts matches.

## Services and startup

- `configure` prepares ownership of the configuration and lost-match directories,
  then switches to the `node` user to create shared server secrets and separate
  API/game configuration files in `./data/config`. API uses `game:8001` internally; the game server
  and browser build use the public hostname.
- `db` runs PostgreSQL. `redis` runs Redis with AOF persistence. Neither publishes
  a host port.
- `migrate` waits for PostgreSQL and configuration, then runs the repository's
  existing `db:migrate` command. It applies committed migrations; it does not
  generate or seed them. Its `NODE_ENV=development` is needed because the
  migration CLI imports the source configuration instead of a production bundle.
- `api` starts after migrations and Redis are ready.
- `game` starts after API is ready and launches match processes within its
  container. Compose enables an init process for the Node.js containers.
- `web` serves the production client through Nginx and proxies `/api`, `/private`
  and `/team_v2` to API, including WebSocket upgrades.

Nginx dynamically resolves the `api` service name, caching DNS answers for five
seconds. The official image entrypoint reads DNS servers from the container's
`/etc/resolv.conf` and substitutes them into the configuration template, so this
works with both Docker and Podman. Only `NGINX_LOCAL_RESOLVERS` is substituted;
Nginx request variables remain intact. If API is recreated with a new IP, the
proxy discovers it without a reload. Requests can still fail while API is
restarting or until DNS refreshes; existing API WebSockets may disconnect.

The server image intentionally retains migration tooling and source files so
the API, game server and migration service share one image. The web image only
contains Nginx and compiled client assets. Both builds use the repository's
package-manager version and frozen lockfile. Local `.env`, game configuration,
`node_modules` and build outputs are excluded from the build context.

The only application-code change is support for optional `REDIS_URL`. Outside
Compose, an unset variable preserves the existing Redis connection defaults.

## Persistent data and maintenance

Bind mounts store persistent data in subdirectories of `./data`, relative to
the repository's `compose.yaml`:

| Host directory | Contents |
| --- | --- |
| `./data/postgres` | PostgreSQL database |
| `./data/redis` | Redis persistence files |
| `./data/config` | Configuration and shared secrets |
| `./data/lost-games` | Match results awaiting delivery to API |

Docker creates missing directories on startup. The `configure` service initially
runs as root to assign `config` and `lost-games` to the image's `node` user
(UID/GID 1000:1000), then drops privileges before generating configuration.
API, game and migrations continue to run as `node`. The official PostgreSQL
and Redis entrypoints prepare their own data-directory permissions.
The entire `data/` directory is excluded from Git and Docker build contexts.

```sh
docker compose ps -a
docker compose logs -f api game
docker compose logs configure migrate
docker compose down
docker compose up -d
```

Both `docker compose down` and `docker compose down -v` preserve these host
directories. Removing `./data` manually deletes the stored data. Back up the
PostgreSQL database and configuration directory before destructive changes or
upgrades. Use a database dump or stop PostgreSQL before copying its data files.

If you previously ran the named-volume version, existing data is not migrated
automatically. Stop the old stack without `-v` and copy each old volume's contents
into the corresponding `./data` subdirectory before starting this configuration.
Preserve the configuration/secrets together with the database. Keep the old
volumes until the migrated data has been verified.

Initialization preserves existing configuration fields such as game modes,
theme and additional secrets. It reapplies Compose-managed network settings,
database credentials and caching on each run. API updates to its HJSON file
persist in `./data/config`. Shared API/IP secrets are generated once
and retained in `secrets.hjson`.

Changing `POSTGRES_PASSWORD` in `.env` does not change the password of an already
initialized PostgreSQL role. Update the role password in PostgreSQL as well;
do not delete the database directory to rotate a password.

## Scope

This configuration provides HTTP/WS hosting for local use or a server with
directly reachable game ports. It does not configure TLS or OAuth providers.
PostgreSQL enables database-backed features, but Google/Discord sign-in still
requires provider credentials and appropriate public/client configuration.
Production authentication uses secure cookies, so remote account login also
needs HTTPS.

For HTTPS deployment, configure TLS for both the website and the game WebSockets
(including the match-port range) and corresponding public settings in the
client build and server configuration. Merely putting HTTPS in front of Nginx
does not enable WSS for the game. The supplied generator intentionally configures
HTTP/WS; adapting TLS settings requires adjusting the Docker configuration.

The repository reads its revision using Git at runtime. Since `.git` is excluded
from these images, the version may be reported as `Unknown`, with a startup log
message; this does not prevent the game from running.
