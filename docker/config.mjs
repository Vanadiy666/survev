import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import hjson from "hjson";

const host = process.env.PUBLIC_HOST || "localhost";
const port = Number(process.env.WEB_PORT || 8080);
if (!/^[a-zA-Z0-9.-]+$/.test(host) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PUBLIC_HOST must be a hostname or IPv4 address; WEB_PORT must be a valid port");
}
const region = { https: false, address: `${host}:8001`, l10n: "index-local" };
const publicConfig = {
    oauthRedirectURI: `http://${host}:${port}`,
    regions: { local: region },
};

if (process.argv[2] === "build") {
    // Only public settings enter the client build layer.
    fs.writeFileSync("survev-config.hjson", JSON.stringify(publicConfig));
} else {
    const configDir = process.env.CONFIG_DIR || "/config";
    fs.mkdirSync(configDir, { recursive: true });
    const read = (file) => fs.existsSync(file) ? hjson.parse(fs.readFileSync(file, "utf8")) : {};
    const write = (file, data) => fs.writeFileSync(file, hjson.stringify(data), { mode: 0o600 });
    const secretsPath = path.join(configDir, "secrets.hjson");
    const secrets = read(secretsPath);
    secrets.SURVEV_API_KEY ||= randomBytes(64).toString("base64");
    secrets.SURVEV_IP_SECRET ||= randomBytes(32).toString("base64");
    write(secretsPath, secrets);
    for (const role of ["api", "game"]) {
        const file = path.join(configDir, `${role}.hjson`);
        const previous = read(file);
        write(file, {
            ...previous,
            ...publicConfig,
            secrets: { ...previous.secrets, ...secrets },
            apiServer: { host: "0.0.0.0", port: 8000, proxyIPHeader: "X-Real-IP" },
            gameServer: {
                host: "0.0.0.0", port: 8001, apiServerUrl: "http://api:8000",
                thisRegion: "local", firstGamePort: 9000, maxGames: 64,
            },
            regions: { local: role === "api" ? { ...region, address: "game:8001" } : region },
            database: {
                enabled: true, host: "db", port: 5432,
                user: "survev", database: "survev",
                password: process.env.POSTGRES_PASSWORD || "survev",
            },
            cachingEnabled: true,
        });
    }
}
