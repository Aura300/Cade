// The Cloudflare account Cade is deployed to, for every npm script that runs
// wrangler. A login with several accounts otherwise makes wrangler ask, or
// fail when it can't, each time.
//
// It's kept in .cade/cloudflare.json as { "accountId" }, written the first time a
// script runs with CLOUDFLARE_ACCOUNT_ID set, as in
// `CLOUDFLARE_ACCOUNT_ID=… npm run deploy`; from then on, importing this sets
// it for wrangler, and the scripts it starts, unless it's set already.
//
// A custom domain for the Worker can be added by hand as { "domain" }, such as
// "api.example.com"; `wrangler.mjs` then deploys to it (see there), so
// wrangler.toml stays free of anyone's domain.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const FILE = fileURLToPath(new URL("../.cade/cloudflare.json", import.meta.url));

function read() {
  try {
    return JSON.parse(readFileSync(FILE, "utf8"));
  } catch {
    return {};
  }
}

export const domain = read().domain;
const accountId = read().accountId;
if (!process.env.CLOUDFLARE_ACCOUNT_ID && accountId) {
  process.env.CLOUDFLARE_ACCOUNT_ID = accountId;
} else if (process.env.CLOUDFLARE_ACCOUNT_ID && !accountId && !process.env.NODE_TEST_CONTEXT) {
  mkdirSync(dirname(FILE), { recursive: true });
  writeFileSync(FILE, `${JSON.stringify({ ...read(), accountId: process.env.CLOUDFLARE_ACCOUNT_ID }, null, 2)}\n`);
  console.log(`Saved Cloudflare account ${process.env.CLOUDFLARE_ACCOUNT_ID} to .cade/cloudflare.json; it needn't be given again.`);
}
