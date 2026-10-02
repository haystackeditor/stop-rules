/** Where Clef's questions go and what they carry: the Cloudflare account and token, or the team server. */

import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { login, parseEndpoint, resolveCredentials } from "../src/credentials.js";
import type { Judge } from "../src/judge.js";
import type { LoadedSettings } from "../src/settings.js";

const ACCOUNT = "0123456789ABCDEF0123456789abcdef";
const CLEF: Judge = { kind: "clef", model: "clef" };
const NO_SETTINGS: LoadedSettings = { settings: {}, file: "/repo/.stop-rules.json", exists: false };

const homes: string[] = [];
async function configHome(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "stop-rules-test-"));
  homes.push(dir);
  return dir;
}
after(async () => {
  for (const dir of homes) await fs.rm(dir, { recursive: true, force: true });
});

describe("Clef credentials", () => {
  it("builds the Workers AI URL from the account and model in the environment", async () => {
    const env = { XDG_CONFIG_HOME: await configHome(), CLOUDFLARE_ACCOUNT_ID: ACCOUNT, CLOUDFLARE_API_TOKEN: "tok" };
    const result = await resolveCredentials(NO_SETTINGS, env, { kind: "clef", model: "clef-flash" });
    assert.ok(result.ok);
    assert.equal(result.credentials.mode, "local");
    assert.equal(
      result.credentials.endpoint,
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT.toLowerCase()}/ai/run/@cf/cloudflare/clef-flash`,
    );
    assert.equal(result.credentials.bearer, "tok");
  });

  it("says which of the two values is missing", async () => {
    const home = await configHome();
    const neither = await resolveCredentials(NO_SETTINGS, { XDG_CONFIG_HOME: home }, CLEF);
    assert.match(!neither.ok ? neither.reason : "", /no Cloudflare account id or API token for Clef/);
    const noToken = await resolveCredentials(NO_SETTINGS, { XDG_CONFIG_HOME: home, CLOUDFLARE_ACCOUNT_ID: ACCOUNT }, CLEF);
    assert.match(!noToken.ok ? noToken.reason : "", /no Cloudflare API token/);
    const noAccount = await resolveCredentials(NO_SETTINGS, { XDG_CONFIG_HOME: home, CLOUDFLARE_API_TOKEN: "tok" }, CLEF);
    assert.match(!noAccount.ok ? noAccount.reason : "", /no Cloudflare account id/);
  });

  it("refuses an account id that is not one, such as a pasted token", async () => {
    const env = { XDG_CONFIG_HOME: await configHome(), CLOUDFLARE_ACCOUNT_ID: "not-an-account", CLOUDFLARE_API_TOKEN: "tok" };
    const result = await resolveCredentials(NO_SETTINGS, env, CLEF);
    assert.match(!result.ok ? result.reason : "", /CLOUDFLARE_ACCOUNT_ID does not hold a Cloudflare account id/);
  });

  it("reads what login stored, mode 0600", async () => {
    const home = await configHome();
    const env = { XDG_CONFIG_HOME: home };
    const bad = await login(env, [{ target: "cloudflare-account", secret: "nope" }]);
    assert.equal(bad.ok, false);
    assert.equal((await login(env, [{ target: "cloudflare-account", secret: ACCOUNT }])).ok, true);
    assert.equal((await login(env, [{ target: "cloudflare-token", secret: "stored-token\n" }])).ok, true);
    const file = path.join(home, "stop-rules", "cloudflare-token");
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    const result = await resolveCredentials(NO_SETTINGS, env, CLEF);
    assert.ok(result.ok);
    assert.equal(result.credentials.bearer, "stored-token");
    assert.match(result.credentials.endpoint, new RegExp(`/accounts/${ACCOUNT.toLowerCase()}/`));
  });

  it("stores a token and account id together or not at all", async () => {
    const home = await configHome();
    const env = { XDG_CONFIG_HOME: home };
    const accountA = "a".repeat(32);
    const accountB = "b".repeat(32);
    const both = (account: string, token: string) =>
      login(env, [
        { target: "cloudflare-account", secret: account },
        { target: "cloudflare-token", secret: token },
      ]);
    assert.equal((await both(accountA, "token-for-a")).ok, true);
    const stored = async (name: string) => (await fs.readFile(path.join(home, "stop-rules", name), "utf8")).trim();

    // A new account with a token that never arrived: nothing changes, not even the account.
    const noToken = await both(accountB, "  \n");
    assert.equal(noToken.ok, false);
    assert.match(noToken.lines.join("\n"), /nothing arrived on stdin[\s\S]*Nothing was stored/);
    assert.equal(await stored("cloudflare-account"), accountA);
    assert.equal(await stored("cloudflare-token"), "token-for-a");

    // A mistyped account with a good token: the token is not written either.
    const badAccount = await both("not-an-account", "token-for-b");
    assert.equal(badAccount.ok, false);
    assert.equal(await stored("cloudflare-account"), accountA);
    assert.equal(await stored("cloudflare-token"), "token-for-a");

    // The account on its own still works as before.
    assert.equal((await login(env, [{ target: "cloudflare-account", secret: accountB }])).ok, true);
    assert.equal(await stored("cloudflare-account"), accountB);
    assert.equal(await stored("cloudflare-token"), "token-for-a");
  });

  it("sends team mode to the server's Clef route with the team token", async () => {
    const env = { XDG_CONFIG_HOME: await configHome(), STOP_RULES_ENDPOINT: "https://rules.example.com/v1/clef", STOP_RULES_TOKEN: "team" };
    const result = await resolveCredentials(NO_SETTINGS, env, CLEF);
    assert.ok(result.ok);
    assert.equal(result.credentials.mode, "team");
    assert.equal(result.credentials.endpoint, "https://rules.example.com/v1/clef");
    assert.equal(result.credentials.bearer, "team");
    assert.deepEqual(parseEndpoint("https://rules.example.com/"), {
      ok: true,
      base: "https://rules.example.com",
      post: "https://rules.example.com/v1/clef",
    });
  });
});
