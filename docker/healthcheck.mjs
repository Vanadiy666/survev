import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import hjson from "hjson";

const role = process.env.CONFIG_ROLE === "api" ? "api" : "game";
const config = hjson.parse(fs.readFileSync(`/config/${role}.hjson`, "utf8"));
const server = role === "api" ? config.apiServer : config.gameServer;
const tls = role === "game" && !!server.ssl;
// This loopback probe only checks readiness. Public/API TLS verification stays on.
const request = (tls ? https : http).get({
    hostname: "127.0.0.1",
    port: server.port,
    path: role === "api" ? "/api/site_info" : "/health",
    rejectUnauthorized: false,
    timeout: 4000,
}, (response) => {
    response.resume();
    process.exit(response.statusCode === 200 ? 0 : 1);
});
request.on("error", () => process.exit(1));
request.on("timeout", () => request.destroy());
