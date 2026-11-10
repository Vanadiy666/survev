import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import hjson from "hjson";

const script = fileURLToPath(new URL("../../docker/config.mjs", import.meta.url));
function fixture(t, source = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "survev-docker-config-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.mkdirSync(path.join(dir, "client"));
    const sourcePath = path.join(dir, "input.hjson");
    fs.writeFileSync(sourcePath, JSON.stringify(source));
    return {
        dir,
        run(mode, extra = {}) {
            execFileSync(process.execPath, [script, ...(mode ? [mode] : [])], {
                cwd: dir,
                env: {
                    ...process.env, CONFIG_SOURCE: sourcePath, CONFIG_DIR: path.join(dir, "config"),
                    PUBLIC_HOST: "play.example.org", WEB_PORT: "8080", GAME_PORT: "8002",
                    POSTGRES_PASSWORD: "db-private", ...extra,
                },
            });
        },
        read(file) { return hjson.parse(fs.readFileSync(path.join(dir, file), "utf8")); },
    };
}

test("default deployment retains identity and API edits across regeneration", (t) => {
    const f = fixture(t);
    f.run();
    const api = f.read("config/api.hjson");
    const game = f.read("config/game.hjson");
    assert.equal(api.regions.local.address, "game:8001");
    assert.equal(game.regions.local.address, "play.example.org:8002");
    assert.equal(api.secrets.SURVEV_API_KEY, game.secrets.SURVEV_API_KEY);
    api.modes = [{ mapName: "cobalt", teamMode: 2, enabled: true }];
    api.clientTheme = "cobalt";
    fs.writeFileSync(path.join(f.dir, "config/api.hjson"), JSON.stringify(api));
    f.run(undefined, { PUBLIC_HOST: "new.example.org", GAME_PORT: "8003" });
    const updated = f.read("config/api.hjson");
    assert.deepEqual(updated.modes, api.modes);
    assert.equal(updated.clientTheme, "cobalt");
    assert.equal(updated.secrets.SURVEV_API_KEY, api.secrets.SURVEV_API_KEY);
    assert.equal(f.read("config/game.hjson").regions.local.address, "new.example.org:8003");
});

test("shared config supports TLS, regions and public build settings without leaking secrets", (t) => {
    const source = {
        oauthRedirectURI: "https://play.example.org",
        passType: "custom-pass",
        captchaEnabled: true,
        gameServer: { thisRegion: "eu", firstGamePort: 9100, maxGames: 8,
            ssl: { keyFile: "/certs/privkey.pem", certFile: "/certs/fullchain.pem" } },
        regions: {
            eu: { https: true, address: "eu.example.org:8002", l10n: "index-europe" },
            na: { https: true, address: "na.example.org:8001", l10n: "index-north-america" },
        },
        proxies: { "other.example.org": { google: false, discord: true, mock: false } },
        secrets: {
            GOOGLE_CLIENT_ID: "google-id", GOOGLE_SECRET_ID: "google-private",
            DISCORD_CLIENT_ID: "discord-id", DISCORD_SECRET_ID: "discord-private",
            DISCORD_BOT_TOKEN: "bot-private", TURNSTILE_SECRET_KEY: "captcha-private",
            TURNSTILE_SITE_KEY: "captcha-public", SURVEV_API_KEY: "api-private",
            SURVEV_IP_SECRET: "ip-private", GAMEMONETIZE_ID: "ads-public",
            SPELLSYNC_PROJECT_ID: "42", SPELLSYNC_PUBLIC_TOKEN: "spellsync-public",
        },
    };
    const f = fixture(t, source);
    f.run();
    f.run("build");
    const api = f.read("config/api.hjson");
    const game = f.read("config/game.hjson");
    const client = f.read("survev-config.hjson");
    assert.deepEqual(api.regions, source.regions);
    assert.deepEqual(client.regions, source.regions);
    assert.deepEqual(game.gameServer.ssl, source.gameServer.ssl);
    assert.equal(game.gameServer.firstGamePort, 9100);
    assert.equal(game.gameServer.maxGames, 8);
    assert.equal(game.gameServer.apiServerUrl, "http://api:8000");
    assert.equal(api.database.host, "db");
    assert.equal(api.passType, client.passType);
    assert.equal(client.secrets.TURNSTILE_SITE_KEY, "captcha-public");
    assert.deepEqual(client.proxies["play.example.org"], { google: true, discord: true, mock: false });
    assert.deepEqual(client.proxies["other.example.org"], source.proxies["other.example.org"]);
    assert.equal(client.database, undefined);
    assert.equal(client.gameServer, undefined);
    assert.ok(!JSON.stringify(client).includes("private"));
    assert.equal(fs.readFileSync(path.join(f.dir, "client/.env.production.local"), "utf8"), 'VITE_GAMEMONETIZE_ID="ads-public"\n');
    assert.deepEqual(f.read("input.hjson"), source);
    f.run();
    assert.deepEqual(f.read("config/game.hjson").gameServer.ssl, source.gameServer.ssl);
});

test("explicit source keys take precedence over generated deployment keys", (t) => {
    const f = fixture(t, { secrets: { SURVEV_API_KEY: "imported", SURVEV_IP_SECRET: "imported-ip" } });
    fs.mkdirSync(path.join(f.dir, "config"));
    fs.writeFileSync(path.join(f.dir, "config/secrets.hjson"), JSON.stringify({ SURVEV_API_KEY: "existing", SURVEV_IP_SECRET: "existing-ip" }));
    f.run();
    assert.equal(f.read("config/api.hjson").secrets.SURVEV_API_KEY, "imported");
    assert.equal(f.read("config/game.hjson").secrets.SURVEV_IP_SECRET, "imported-ip");
});

test("external endpoints and explicit listen settings are never replaced", (t) => {
    const source = {
        apiServer: { host: "127.0.0.1", port: 8100, proxyIPHeader: "Forwarded-IP" },
        gameServer: { apiServerUrl: "https://api.example.org", port: 8101, thisRegion: "eu" },
        database: { enabled: true, host: "external-db", port: 5433, user: "custom", database: "other", password: "source-password" },
        regions: { eu: { https: false, address: "eu.example.org:8101", l10n: "index-europe" } },
        cachingEnabled: false,
    };
    const f = fixture(t, source);
    f.run();
    for (const role of ["api", "game"]) {
        const c = f.read(`config/${role}.hjson`);
        assert.deepEqual(c.apiServer, source.apiServer);
        assert.deepEqual(c.database, source.database);
        assert.deepEqual(c.regions, source.regions);
        assert.equal(c.gameServer.apiServerUrl, source.gameServer.apiServerUrl);
        assert.equal(c.gameServer.port, 8101);
        assert.equal(c.cachingEnabled, false);
    }
});

test("API-only region lists need no local game; changed port defaults replace previous defaults", (t) => {
    const f = fixture(t, { regions: { remote: { https: false, address: "remote:8001", l10n: "remote" } }, database: { enabled: false } });
    f.run();
    f.run("build");
    assert.deepEqual(Object.keys(f.read("survev-config.hjson").regions), ["remote"]);
    assert.equal(f.read("config/api.hjson").database.enabled, false);
    const g = fixture(t);
    g.run();
    g.run(undefined, { API_INTERNAL_PORT: "8100", GAME_INTERNAL_PORT: "8101", MATCH_PORT_START: "9200", MATCH_PORT_END: "9207" });
    const c = g.read("config/game.hjson");
    assert.equal(c.gameServer.port, 8101);
    assert.equal(c.gameServer.apiServerUrl, "http://api:8100");
    assert.equal(c.gameServer.firstGamePort, 9200);
    assert.equal(c.gameServer.maxGames, 8);
    assert.equal(g.read("config/api.hjson").regions.local.address, "game:8101");
});

test("removing source settings removes stale credentials and restores defaults", (t) => {
    const f = fixture(t, { gameServer: { apiServerUrl: "http://old-api:8000" }, secrets: { GOOGLE_CLIENT_ID: "old-id", GOOGLE_SECRET_ID: "old-secret" } });
    f.run();
    fs.writeFileSync(path.join(f.dir, "input.hjson"), "{}");
    f.run();
    f.run("build");
    assert.equal(f.read("config/api.hjson").secrets.GOOGLE_SECRET_ID, undefined);
    assert.equal(f.read("config/game.hjson").gameServer.apiServerUrl, "http://api:8000");
    assert.equal(f.read("survev-config.hjson").proxies["play.example.org"].google, false);
});
