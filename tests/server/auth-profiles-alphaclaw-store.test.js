const fs = require("fs");
const path = require("path");
const os = require("os");

// AlphaClaw-owned credentials (the X cookie session / OAuth1 profiles) must live
// under ALPHACLAW_DIR, never in <OPENCLAW_DIR>/agents/<id>/agent/auth-profiles.json:
// OpenClaw 2026.8.1+ refuses its whole auth store while that legacy file exists.

let tmpDir;
let ap;
let legacyPath;
let ownedPath;

const openclawDir = () => path.join(tmpDir, ".openclaw");

const writeOpenclawConfig = (extra = {}) => {
  fs.writeFileSync(
    path.join(openclawDir(), "openclaw.json"),
    JSON.stringify(
      {
        agents: {
          defaults: {
            model: { primary: "anthropic/claude-opus-4-6" },
            models: { "anthropic/claude-opus-4-6": {} },
          },
        },
        gateway: { port: 18789 },
        ...extra,
      },
      null,
      2,
    ),
  );
};

const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));

const writeLegacyStore = (profiles) => {
  fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
  fs.writeFileSync(
    legacyPath,
    JSON.stringify({ version: 1, profiles }, null, 2),
  );
};

const kXSession = {
  type: "cookie",
  provider: "x-twitter",
  access: "auth_token=aaa; ct0=bbb; twid=ccc",
  userId: "42",
  username: "someone",
};

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ac-owned-profiles-"));
  process.env.ALPHACLAW_ROOT_DIR = tmpDir;

  fs.mkdirSync(path.join(openclawDir(), "agents", "main", "agent"), {
    recursive: true,
  });
  legacyPath = path.join(
    openclawDir(),
    "agents",
    "main",
    "agent",
    "auth-profiles.json",
  );
  ownedPath = path.join(tmpDir, "alphaclaw-profiles.json");

  const { createAuthProfiles } = require("../../lib/server/auth-profiles");
  ap = createAuthProfiles();
});

beforeEach(() => {
  writeOpenclawConfig();
  fs.rmSync(legacyPath, { force: true });
  fs.rmSync(ownedPath, { force: true });
});

afterAll(() => {
  delete process.env.ALPHACLAW_ROOT_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("server/auth-profiles — AlphaClaw-owned credential store", () => {
  it("saves the X web session outside the OpenClaw agent directory", () => {
    ap.upsertProfile("x-twitter:web-session", kXSession);

    expect(fs.existsSync(legacyPath)).toBe(false);
    expect(fs.existsSync(ownedPath)).toBe(true);
    expect(readJson(ownedPath).profiles["x-twitter:web-session"]).toEqual(
      kXSession,
    );
  });

  it("writes the owned store with 0600 permissions", () => {
    ap.upsertProfile("x-twitter:web-session", kXSession);
    const mode = fs.statSync(ownedPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("does not reference owned profiles from openclaw.json", () => {
    ap.upsertProfile("x-twitter:web-session", kXSession);
    const cfg = readJson(path.join(openclawDir(), "openclaw.json"));
    expect(cfg.auth?.profiles?.["x-twitter:web-session"]).toBeUndefined();
  });

  it("reads the saved session back through getProfile (crawler read path)", () => {
    ap.upsertProfile("x-twitter:web-session", kXSession);
    const profile = ap.getProfile("x-twitter:web-session");
    expect(profile).toMatchObject({
      id: "x-twitter:web-session",
      access: kXSession.access,
      username: "someone",
    });
  });

  it("lists owned profiles alongside OpenClaw profiles", () => {
    ap.upsertProfile("x-twitter:web-session", kXSession);
    ap.upsertProfile("anthropic:default", {
      type: "api_key",
      provider: "anthropic",
      key: "sk-ant-test",
    });
    const ids = ap.listProfiles().map((p) => p.id);
    expect(ids).toContain("x-twitter:web-session");
    expect(ids).toContain("anthropic:default");
    expect(ap.listProfilesByProvider("x-twitter").map((p) => p.id)).toEqual([
      "x-twitter:web-session",
    ]);
  });

  it("removes an owned profile from the new store", () => {
    ap.upsertProfile("x-twitter:web-session", kXSession);
    expect(ap.removeProfile("x-twitter:web-session")).toBe(true);
    expect(ap.getProfile("x-twitter:web-session")).toBeNull();
    expect(readJson(ownedPath).profiles["x-twitter:web-session"]).toBeUndefined();
    expect(fs.existsSync(legacyPath)).toBe(false);
  });

  it("keeps real provider credentials in the OpenClaw store", () => {
    ap.upsertProfile("anthropic:default", {
      type: "api_key",
      provider: "anthropic",
      key: "sk-ant-test",
    });
    expect(fs.existsSync(legacyPath)).toBe(true);
    expect(readJson(legacyPath).profiles["anthropic:default"]).toBeDefined();
  });

  it("migrates a legacy X profile and deletes the emptied legacy file", () => {
    writeLegacyStore({ "x-twitter:web-session": kXSession });
    writeOpenclawConfig({
      auth: { profiles: { "x-twitter:web-session": { provider: "x-twitter", mode: "oauth" } } },
    });

    const profile = ap.getProfile("x-twitter:web-session");

    expect(profile).toMatchObject({ access: kXSession.access });
    expect(fs.existsSync(legacyPath)).toBe(false);
    expect(readJson(ownedPath).profiles["x-twitter:web-session"]).toEqual(
      kXSession,
    );
    const cfg = readJson(path.join(openclawDir(), "openclaw.json"));
    expect(cfg.auth?.profiles?.["x-twitter:web-session"]).toBeUndefined();
  });

  it("migrates the X profile but preserves a legacy file holding a Codex profile", () => {
    const codex = {
      type: "oauth",
      provider: "openai-codex",
      access: "jwt",
      refresh: "rt",
      expires: 9999999999999,
    };
    writeLegacyStore({
      "x-twitter:web-session": kXSession,
      "openai-codex:codex-cli": codex,
    });

    expect(ap.getProfile("x-twitter:web-session")).toMatchObject({
      access: kXSession.access,
    });

    expect(fs.existsSync(legacyPath)).toBe(true);
    const legacy = readJson(legacyPath);
    expect(legacy.profiles["x-twitter:web-session"]).toBeUndefined();
    expect(legacy.profiles["openai-codex:codex-cli"]).toEqual(codex);
    expect(ap.getProfile("openai-codex:codex-cli")).toMatchObject({
      provider: "openai-codex",
    });
    expect(readJson(ownedPath).profiles["x-twitter:web-session"]).toEqual(
      kXSession,
    );
  });

  it("also migrates the X OAuth1 profile", () => {
    const oauth1 = {
      type: "oauth",
      provider: "x-twitter",
      key: "ck",
      token: "cs",
      access: "at",
      refresh: "as",
    };
    writeLegacyStore({ "x-twitter:oauth1": oauth1 });

    expect(ap.getProfile("x-twitter:oauth1")).toMatchObject({ key: "ck" });
    expect(fs.existsSync(legacyPath)).toBe(false);
    expect(readJson(ownedPath).profiles["x-twitter:oauth1"]).toEqual(oauth1);
  });

  it("skips a corrupt legacy file without throwing", () => {
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    fs.writeFileSync(legacyPath, "{ not json at all");

    expect(() => ap.getProfile("x-twitter:web-session")).not.toThrow();
    expect(ap.getProfile("x-twitter:web-session")).toBeNull();
    expect(() => ap.listProfiles()).not.toThrow();
    // A file we could not parse is left exactly as-is.
    expect(fs.readFileSync(legacyPath, "utf8")).toBe("{ not json at all");

    expect(() =>
      ap.upsertProfile("x-twitter:web-session", kXSession),
    ).not.toThrow();
    expect(readJson(ownedPath).profiles["x-twitter:web-session"]).toEqual(
      kXSession,
    );
  });

  it("leaves a legacy file with no owned profiles untouched", () => {
    const codex = {
      type: "oauth",
      provider: "openai-codex",
      access: "jwt",
      refresh: "rt",
      expires: 1,
    };
    writeLegacyStore({ "openai-codex:codex-cli": codex });
    const before = fs.readFileSync(legacyPath, "utf8");

    ap.listProfiles();

    expect(fs.readFileSync(legacyPath, "utf8")).toBe(before);
  });

  it("prefers a re-saved owned profile over the legacy copy", () => {
    ap.upsertProfile("x-twitter:web-session", {
      ...kXSession,
      access: "fresh-cookies",
    });
    writeLegacyStore({ "x-twitter:web-session": kXSession });

    expect(ap.getProfile("x-twitter:web-session").access).toBe("fresh-cookies");
    expect(fs.existsSync(legacyPath)).toBe(false);
  });
});
