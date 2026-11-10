import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import hjson from "hjson";

const read = (file) => fs.existsSync(file) ? hjson.parse(fs.readFileSync(file, "utf8")) : {};
const write = (file, data) => fs.writeFileSync(file, hjson.stringify(data), { mode: 0o600 });
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
function merge(...sources) {
    const result = {};
    for (const source of sources) {
        for (const [key, value] of Object.entries(source || {})) {
            if (["__proto__", "constructor", "prototype"].includes(key)) continue;
            result[key] = object(value) ? merge(result[key], value) : value;
        }
    }
    return result;
}

const host = process.env.PUBLIC_HOST || "localhost";
const port = Number(process.env.WEB_PORT || 8080);
const gamePort = Number(process.env.GAME_PORT || 8001);
if (!/^[a-zA-Z0-9.-]+$/.test(host)) {
    throw new Error("PUBLIC_HOST must be a hostname or IPv4 address");
}
for (const [name, value] of [["WEB_PORT", port], ["GAME_PORT", gamePort]]) {
    if (!Number.isInteger(value) || value < 1 || value > 65535) {
        throw new Error(`${name} must be a valid port (1–65535)`);
    }
}
// The same source is mounted at runtime and as a build secret. Never COPY it.
if (process.env.CONFIG_SOURCE && !fs.existsSync(process.env.CONFIG_SOURCE)) {
    throw new Error("CONFIG_SOURCE does not exist");
}
const source = read(process.env.CONFIG_SOURCE || "/run/secrets/survev_config");
const regionId = source.gameServer?.thisRegion || "local";
const defaults = {
    oauthRedirectURI: `http://${host}:${port}`,
    regions: { [regionId]: { https: false, address: `${host}:${gamePort}`, l10n: "index-local" } },
};
const settings = merge(defaults, source);
settings.oauthRedirectURI ||= defaults.oauthRedirectURI;
// A supplied region list is authoritative, not merged with a phantom local region.
if (source.regions) settings.regions = source.regions;


if (process.argv[2] === "build") {
    // Explicit allowlist: no database credentials, OAuth secrets, bot token or API key.
    const publicConfig = {};
    for (const key of ["oauthRedirectURI", "oauthBasePath", "regions", "passType", "clientTheme"]) {
        if (settings[key] !== undefined) publicConfig[key] = settings[key];
    }
    const secrets = settings.secrets || {};
    publicConfig.secrets = {};
    for (const key of ["TURNSTILE_SITE_KEY", "AD_PREFIX", "GAMEMONETIZE_ID", "SPELLSYNC_PROJECT_ID", "SPELLSYNC_PUBLIC_TOKEN"]) {
        if (secrets[key] !== undefined) publicConfig.secrets[key] = secrets[key];
    }
    publicConfig.proxies = merge({
        [new URL(settings.oauthRedirectURI).hostname]: {
            google: !!(secrets.GOOGLE_CLIENT_ID && secrets.GOOGLE_SECRET_ID),
            discord: !!(secrets.DISCORD_CLIENT_ID && secrets.DISCORD_SECRET_ID),
            mock: !!settings.debug?.allowMockAccount,
        },
    }, settings.proxies);
    write("survev-config.hjson", publicConfig);
    // This integration reads import.meta.env rather than the config define.
    fs.writeFileSync("client/.env.production.local", `VITE_GAMEMONETIZE_ID=${JSON.stringify(secrets.GAMEMONETIZE_ID || "")}\n`);
} else {
    const configDir = process.env.CONFIG_DIR || "/config";
    fs.mkdirSync(configDir, { recursive: true });
    const secretsPath = path.join(configDir, "secrets.hjson");
    const secrets = read(secretsPath);
    // Explicit source keys also support joining an existing deployment.
    secrets.SURVEV_API_KEY = source.secrets?.SURVEV_API_KEY || secrets.SURVEV_API_KEY || randomBytes(64).toString("base64");
    secrets.SURVEV_IP_SECRET = source.secrets?.SURVEV_IP_SECRET || secrets.SURVEV_IP_SECRET || randomBytes(32).toString("base64");
    write(secretsPath, secrets);
    for (const role of ["api", "game"]) {
        const file = path.join(configDir, `${role}.hjson`);
        const previous = read(file);
        // Only API-managed settings are persisted here. Everything else comes
        // from the source, so deleting an override also removes its old value.
        const saved = {};
        for (const key of ["modes", "clientTheme", "captchaEnabled"]) {
            if (previous[key] !== undefined) saved[key] = previous[key];
        }
        const config = merge(saved, settings);
        config.secrets = merge(source.secrets, {
            SURVEV_API_KEY: secrets.SURVEV_API_KEY,
            SURVEV_IP_SECRET: secrets.SURVEV_IP_SECRET,
        });
        // Container addresses are defaults, never overrides of explicit source fields.
        config.apiServer = merge({ host: "0.0.0.0", port: Number(process.env.API_INTERNAL_PORT || 8000), proxyIPHeader: "X-Real-IP" }, config.apiServer);
        const firstPort = Number(process.env.MATCH_PORT_START || 9000);
        const lastPort = Number(process.env.MATCH_PORT_END || 9063);
        config.gameServer = merge({
            firstGamePort: firstPort, maxGames: lastPort - firstPort + 1,
            host: "0.0.0.0", port: Number(process.env.GAME_INTERNAL_PORT || 8001),
            apiServerUrl: `http://api:${config.apiServer.port}`, thisRegion: regionId,
        }, config.gameServer);
        config.database = merge({
            enabled: true, host: "db", port: 5432, user: "survev", database: "survev",
            password: process.env.POSTGRES_PASSWORD || "survev",
        }, config.database);
        config.cachingEnabled ??= true;
        config.regions = structuredClone(settings.regions);
        // Only rewrite the automatically supplied region, never a user's region list.
        if (role === "api" && !source.regions) {
            config.regions[regionId].address = `game:${config.gameServer.port}`;
        }
        write(file, config);
    }
}
