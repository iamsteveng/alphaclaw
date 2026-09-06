const express = require("express");
const request = require("supertest");

const { registerNodeRoutes } = require("../../lib/server/routes/nodes");

const kNodeTimeoutEnvNames = [
  "ALPHACLAW_NODE_ROUTE_TIMEOUT_MS",
  "ALPHACLAW_NODES_STATUS_TIMEOUT_MS",
  "ALPHACLAW_NODES_PENDING_TIMEOUT_MS",
  "ALPHACLAW_NODE_APPROVALS_TIMEOUT_MS",
];

const withNodeTimeoutEnv = async (values, fn) => {
  const previous = Object.fromEntries(
    kNodeTimeoutEnvNames.map((name) => [name, process.env[name]]),
  );
  for (const name of kNodeTimeoutEnvNames) {
    if (values[name] === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = values[name];
    }
  }
  try {
    return await fn();
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
};

const createApp = ({ clawCmd, fsModule, openclawVersion } = {}) => {
  const app = express();
  app.use(express.json());
  registerNodeRoutes({
    app,
    clawCmd,
    openclawDir: "/tmp/openclaw",
    gatewayToken: "",
    fsModule:
      fsModule || {
        readFileSync: vi.fn(() => "{}"),
        writeFileSync: vi.fn(),
        mkdirSync: vi.fn(),
      },
    ...(openclawVersion === undefined ? {} : { openclawVersion }),
  });
  return app;
};

const kLegacyOpenclawVersion = "2026.7.9";
const kSqliteOpenclawVersion = "2026.9.1";

const createApprovalsFsModule = (file) => ({
  readFileSync: vi.fn(() => JSON.stringify(file)),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
});

// `openclaw approvals get --json` / `allowlist add|remove --json` both echo the
// approvals document under `file`, preceded by a human status line on stdout.
const approvalsCliOutput = (allowlist) =>
  `Writing local approvals.\n${JSON.stringify({
    path: "/tmp/openclaw/state/openclaw.sqlite#exec_approvals_config",
    exists: true,
    file: { version: 1, defaults: {}, agents: { "*": { allowlist } } },
    hash: "abc",
  })}`;

describe("server/routes/nodes", () => {
  it("uses default CLI timeouts for status and pending reads", async () => {
    const clawCmd = vi.fn(async (cmd) => {
      if (cmd === "nodes status --json") {
        return {
          ok: true,
          stdout: JSON.stringify({
            nodes: [{ id: "node-1", paired: true }],
            pending: [],
          }),
          stderr: "",
        };
      }
      if (cmd === "nodes pending --json") {
        return {
          ok: true,
          stdout: JSON.stringify({
            pending: [{ requestId: "node-2" }],
          }),
          stderr: "",
        };
      }
      return { ok: true, stdout: "{}", stderr: "" };
    });
    const app = createApp({ clawCmd });

    const res = await request(app).get("/api/nodes");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      nodes: [{ id: "node-1", paired: true }],
      pending: [{ requestId: "node-2", id: "node-2", nodeId: "node-2", paired: false }],
    });
    expect(clawCmd).toHaveBeenNthCalledWith(1, "nodes status --json", {
      quiet: true,
      timeoutMs: 12000,
    });
    expect(clawCmd).toHaveBeenNthCalledWith(2, "nodes pending --json", {
      quiet: true,
      timeoutMs: 12000,
    });
  });

  it("supports env overrides for nodes CLI timeouts", async () => {
    await withNodeTimeoutEnv(
      {
        ALPHACLAW_NODE_ROUTE_TIMEOUT_MS: "18000",
        ALPHACLAW_NODES_STATUS_TIMEOUT_MS: "15000",
        ALPHACLAW_NODES_PENDING_TIMEOUT_MS: "16000",
      },
      async () => {
        const clawCmd = vi.fn(async (cmd) => {
          if (cmd === "nodes status --json") {
            return {
              ok: true,
              stdout: JSON.stringify({ nodes: [], pending: [] }),
              stderr: "",
            };
          }
          if (cmd === "nodes pending --json") {
            return {
              ok: true,
              stdout: JSON.stringify({ pending: [] }),
              stderr: "",
            };
          }
          return { ok: true, stdout: "", stderr: "" };
        });
        const app = createApp({ clawCmd });

        const nodesRes = await request(app).get("/api/nodes");
        const routeRes = await request(app).post("/api/nodes/node-1/route");

        expect(nodesRes.status).toBe(200);
        expect(routeRes.status).toBe(200);
        expect(clawCmd).toHaveBeenNthCalledWith(1, "nodes status --json", {
          quiet: true,
          timeoutMs: 15000,
        });
        expect(clawCmd).toHaveBeenNthCalledWith(2, "nodes pending --json", {
          quiet: true,
          timeoutMs: 16000,
        });
        for (const call of clawCmd.mock.calls.slice(2)) {
          expect(call[1]).toEqual({ quiet: true, timeoutMs: 18000 });
        }
      },
    );
  });

  it("ignores invalid nodes CLI timeout env overrides", async () => {
    await withNodeTimeoutEnv(
      {
        ALPHACLAW_NODE_ROUTE_TIMEOUT_MS: "0",
        ALPHACLAW_NODES_STATUS_TIMEOUT_MS: "bogus",
        ALPHACLAW_NODES_PENDING_TIMEOUT_MS: "-1",
      },
      async () => {
        const clawCmd = vi.fn(async (cmd) => {
          if (cmd === "nodes status --json") {
            return {
              ok: true,
              stdout: JSON.stringify({ nodes: [], pending: [] }),
              stderr: "",
            };
          }
          if (cmd === "nodes pending --json") {
            return {
              ok: true,
              stdout: JSON.stringify({ pending: [] }),
              stderr: "",
            };
          }
          return { ok: true, stdout: "", stderr: "" };
        });
        const app = createApp({ clawCmd });

        const nodesRes = await request(app).get("/api/nodes");
        const routeRes = await request(app).post("/api/nodes/node-1/route");

        expect(nodesRes.status).toBe(200);
        expect(routeRes.status).toBe(200);
        expect(clawCmd).toHaveBeenNthCalledWith(1, "nodes status --json", {
          quiet: true,
          timeoutMs: 12000,
        });
        expect(clawCmd).toHaveBeenNthCalledWith(2, "nodes pending --json", {
          quiet: true,
          timeoutMs: 12000,
        });
        for (const call of clawCmd.mock.calls.slice(2)) {
          expect(call[1]).toEqual({ quiet: true, timeoutMs: 12000 });
        }
      },
    );
  });

  it("surfaces status CLI timeouts with the configured timeout", async () => {
    await withNodeTimeoutEnv(
      {
        ALPHACLAW_NODES_STATUS_TIMEOUT_MS: "9000",
      },
      async () => {
        const clawCmd = vi.fn(async () => ({
          ok: false,
          stdout: "",
          stderr: "",
          timedOut: true,
          failureMessage: "openclaw nodes timed out after 9s",
        }));
        const app = createApp({ clawCmd });

        const res = await request(app).get("/api/nodes");

        expect(res.status).toBe(500);
        expect(res.body).toEqual({
          ok: false,
          error: "openclaw nodes timed out after 9s",
        });
      },
    );
  });

  it("surfaces node routing CLI timeouts with the configured timeout", async () => {
    await withNodeTimeoutEnv(
      {
        ALPHACLAW_NODE_ROUTE_TIMEOUT_MS: "19000",
      },
      async () => {
        const clawCmd = vi.fn(async () => ({
          ok: false,
          stdout: "",
          stderr: "",
          killed: true,
          signal: "SIGTERM",
          timedOut: true,
          failureMessage: "openclaw nodes timed out after 19s",
        }));
        const app = createApp({ clawCmd });

        const res = await request(app).post("/api/nodes/node-1/route");

        expect(res.status).toBe(500);
        expect(res.body).toEqual({
          ok: false,
          error: "openclaw nodes timed out after 19s",
        });
      },
    );
  });

  it("falls back to status-derived pending nodes when pending command fails", async () => {
    const clawCmd = vi.fn(async (cmd) => {
      if (cmd === "nodes status --json") {
        return {
          ok: true,
          stdout: JSON.stringify({
            nodes: [
              { id: "node-1", paired: true },
              { id: "node-2", paired: false },
            ],
          }),
          stderr: "",
        };
      }
      if (cmd === "nodes pending --json") {
        return {
          ok: false,
          stdout: "",
          stderr: "timed out",
        };
      }
      return { ok: true, stdout: "{}", stderr: "" };
    });
    const app = createApp({ clawCmd });

    const res = await request(app).get("/api/nodes");

    expect(res.status).toBe(200);
    expect(res.body.pending).toEqual([{ id: "node-2", paired: false }]);
  });
  describe("exec approvals allowlist", () => {
    it("writes the legacy exec-approvals.json on pre-2.0 OpenClaw", async () => {
      const fsModule = createApprovalsFsModule({ version: 1, agents: {} });
      const clawCmd = vi.fn(async () => ({ ok: true, stdout: "", stderr: "" }));
      const app = createApp({
        clawCmd,
        fsModule,
        openclawVersion: kLegacyOpenclawVersion,
      });

      const res = await request(app)
        .post("/api/nodes/exec-approvals/allowlist")
        .send({ pattern: "/usr/bin/uptime" });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.entry.pattern).toBe("/usr/bin/uptime");
      expect(fsModule.writeFileSync).toHaveBeenCalledTimes(1);
      const [writtenPath, written] = fsModule.writeFileSync.mock.calls[0];
      expect(writtenPath).toBe("/tmp/openclaw/exec-approvals.json");
      expect(JSON.parse(written).agents["*"].allowlist).toEqual([
        expect.objectContaining({ pattern: "/usr/bin/uptime" }),
      ]);
      expect(clawCmd).not.toHaveBeenCalled();
    });

    it("removes from the legacy exec-approvals.json on pre-2.0 OpenClaw", async () => {
      const fsModule = createApprovalsFsModule({
        version: 1,
        agents: { "*": { allowlist: [{ pattern: "/usr/bin/uptime", id: "entry-1" }] } },
      });
      const clawCmd = vi.fn(async () => ({ ok: true, stdout: "", stderr: "" }));
      const app = createApp({
        clawCmd,
        fsModule,
        openclawVersion: kLegacyOpenclawVersion,
      });

      const res = await request(app).delete(
        "/api/nodes/exec-approvals/allowlist/entry-1",
      );

      expect(res.status).toBe(200);
      expect(fsModule.writeFileSync).toHaveBeenCalledTimes(1);
      expect(
        JSON.parse(fsModule.writeFileSync.mock.calls[0][1]).agents["*"].allowlist,
      ).toEqual([]);
      expect(clawCmd).not.toHaveBeenCalled();
    });

    it("reads the allowlist from the approvals CLI on 2.0+", async () => {
      const entry = { pattern: "/usr/bin/uptime", id: "entry-1", lastUsedAt: 42 };
      const fsModule = createApprovalsFsModule({ version: 1, agents: {} });
      const clawCmd = vi.fn(async () => ({
        ok: true,
        stdout: approvalsCliOutput([entry]),
        stderr: "",
      }));
      const app = createApp({
        clawCmd,
        fsModule,
        openclawVersion: kSqliteOpenclawVersion,
      });

      const res = await request(app).get("/api/nodes/exec-approvals");

      expect(res.status).toBe(200);
      expect(res.body.allowlist).toEqual([entry]);
      expect(res.body.file.agents["*"].allowlist).toEqual([entry]);
      expect(clawCmd).toHaveBeenCalledTimes(1);
      expect(clawCmd).toHaveBeenCalledWith("approvals get --json", {
        quiet: true,
        timeoutMs: 12000,
      });
      expect(fsModule.readFileSync).not.toHaveBeenCalled();
    });

    it("surfaces approvals CLI failures on the 2.0+ read", async () => {
      const clawCmd = vi.fn(async () => ({
        ok: false,
        stdout: "",
        stderr: "",
        failureMessage: "openclaw approvals timed out after 12s",
      }));
      const app = createApp({ clawCmd, openclawVersion: kSqliteOpenclawVersion });

      const res = await request(app).get("/api/nodes/exec-approvals");

      expect(res.status).toBe(500);
      expect(res.body).toEqual({
        ok: false,
        error: "openclaw approvals timed out after 12s",
      });
    });

    it("adds through the approvals CLI without touching the legacy file on 2.0+", async () => {
      const added = { pattern: "/usr/bin/uptime", id: "cli-id", lastUsedAt: 99 };
      const fsModule = createApprovalsFsModule({ version: 1, agents: {} });
      const clawCmd = vi.fn(async (cmd) =>
        cmd === "approvals get --json"
          ? { ok: true, stdout: approvalsCliOutput([]), stderr: "" }
          : { ok: true, stdout: approvalsCliOutput([added]), stderr: "" },
      );
      const app = createApp({
        clawCmd,
        fsModule,
        openclawVersion: kSqliteOpenclawVersion,
      });

      const res = await request(app)
        .post("/api/nodes/exec-approvals/allowlist")
        .send({ pattern: "/usr/bin/uptime" });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, entry: added });
      expect(clawCmd).toHaveBeenNthCalledWith(1, "approvals get --json", {
        quiet: true,
        timeoutMs: 12000,
      });
      expect(clawCmd).toHaveBeenNthCalledWith(
        2,
        "approvals allowlist add --agent '*' --json -- '/usr/bin/uptime'",
        { quiet: true, timeoutMs: 12000 },
      );
      expect(fsModule.writeFileSync).not.toHaveBeenCalled();
      expect(fsModule.mkdirSync).not.toHaveBeenCalled();
    });

    it("shell-escapes allowlist patterns passed to the approvals CLI", async () => {
      const pattern = "/usr/bin/it's a $(whoami) --flag";
      const clawCmd = vi.fn(async (cmd) =>
        cmd === "approvals get --json"
          ? { ok: true, stdout: approvalsCliOutput([]), stderr: "" }
          : {
              ok: true,
              stdout: approvalsCliOutput([{ pattern, id: "cli-id", lastUsedAt: 1 }]),
              stderr: "",
            },
      );
      const app = createApp({ clawCmd, openclawVersion: kSqliteOpenclawVersion });

      const res = await request(app)
        .post("/api/nodes/exec-approvals/allowlist")
        .send({ pattern });

      expect(res.status).toBe(200);
      expect(clawCmd.mock.calls[1][0]).toBe(
        `approvals allowlist add --agent '*' --json -- '/usr/bin/it'"'"'s a $(whoami) --flag'`,
      );
    });

    it("skips the approvals CLI write when the pattern already exists on 2.0+", async () => {
      const existing = { pattern: "/usr/bin/uptime", id: "entry-1", lastUsedAt: 42 };
      const clawCmd = vi.fn(async () => ({
        ok: true,
        stdout: approvalsCliOutput([existing]),
        stderr: "",
      }));
      const app = createApp({ clawCmd, openclawVersion: kSqliteOpenclawVersion });

      const res = await request(app)
        .post("/api/nodes/exec-approvals/allowlist")
        .send({ pattern: "/usr/bin/uptime" });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, entry: existing, unchanged: true });
      expect(clawCmd).toHaveBeenCalledTimes(1);
    });

    it("surfaces approvals CLI failures on the 2.0+ add", async () => {
      const clawCmd = vi.fn(async (cmd) =>
        cmd === "approvals get --json"
          ? { ok: true, stdout: approvalsCliOutput([]), stderr: "" }
          : {
              ok: false,
              stdout: "",
              stderr: "",
              failureMessage: "openclaw approvals exited with code 1",
            },
      );
      const app = createApp({ clawCmd, openclawVersion: kSqliteOpenclawVersion });

      const res = await request(app)
        .post("/api/nodes/exec-approvals/allowlist")
        .send({ pattern: "/usr/bin/uptime" });

      expect(res.status).toBe(500);
      expect(res.body).toEqual({
        ok: false,
        error: "openclaw approvals exited with code 1",
      });
    });

    it("removes by resolving the entry id to its pattern on 2.0+", async () => {
      const existing = { pattern: "/usr/bin/uptime", id: "entry-1", lastUsedAt: 42 };
      const fsModule = createApprovalsFsModule({ version: 1, agents: {} });
      const clawCmd = vi.fn(async (cmd) =>
        cmd === "approvals get --json"
          ? { ok: true, stdout: approvalsCliOutput([existing]), stderr: "" }
          : { ok: true, stdout: approvalsCliOutput([]), stderr: "" },
      );
      const app = createApp({
        clawCmd,
        fsModule,
        openclawVersion: kSqliteOpenclawVersion,
      });

      const res = await request(app).delete(
        "/api/nodes/exec-approvals/allowlist/entry-1",
      );

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
      expect(clawCmd).toHaveBeenNthCalledWith(1, "approvals get --json", {
        quiet: true,
        timeoutMs: 12000,
      });
      expect(clawCmd).toHaveBeenNthCalledWith(
        2,
        "approvals allowlist remove --agent '*' --json -- '/usr/bin/uptime'",
        { quiet: true, timeoutMs: 12000 },
      );
      expect(fsModule.writeFileSync).not.toHaveBeenCalled();
    });

    it("returns 404 for an unknown allowlist id on 2.0+", async () => {
      const clawCmd = vi.fn(async () => ({
        ok: true,
        stdout: approvalsCliOutput([]),
        stderr: "",
      }));
      const app = createApp({ clawCmd, openclawVersion: kSqliteOpenclawVersion });

      const res = await request(app).delete(
        "/api/nodes/exec-approvals/allowlist/missing",
      );

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ ok: false, error: "Allowlist entry not found" });
      expect(clawCmd).toHaveBeenCalledTimes(1);
    });

    it("rejects invalid allowlist entries before running any CLI or write", async () => {
      for (const openclawVersion of [kLegacyOpenclawVersion, kSqliteOpenclawVersion]) {
        const fsModule = createApprovalsFsModule({ version: 1, agents: {} });
        const clawCmd = vi.fn(async () => ({ ok: true, stdout: "", stderr: "" }));
        const app = createApp({ clawCmd, fsModule, openclawVersion });

        const missingPattern = await request(app)
          .post("/api/nodes/exec-approvals/allowlist")
          .send({});
        const blankPattern = await request(app)
          .post("/api/nodes/exec-approvals/allowlist")
          .send({ pattern: "   " });
        const blankId = await request(app).delete(
          "/api/nodes/exec-approvals/allowlist/%20",
        );

        expect(missingPattern.status).toBe(400);
        expect(missingPattern.body).toEqual({ ok: false, error: "pattern is required" });
        expect(blankPattern.status).toBe(400);
        expect(blankId.status).toBe(400);
        expect(blankId.body).toEqual({ ok: false, error: "id is required" });
        expect(clawCmd).not.toHaveBeenCalled();
        expect(fsModule.writeFileSync).not.toHaveBeenCalled();
      }
    });

    it("defaults to the installed OpenClaw version, which uses the SQLite store", async () => {
      const fsModule = createApprovalsFsModule({ version: 1, agents: {} });
      const clawCmd = vi.fn(async () => ({
        ok: true,
        stdout: approvalsCliOutput([]),
        stderr: "",
      }));
      const app = createApp({ clawCmd, fsModule });

      const res = await request(app)
        .post("/api/nodes/exec-approvals/allowlist")
        .send({ pattern: "/usr/bin/uptime" });

      expect(res.status).toBe(200);
      expect(clawCmd).toHaveBeenCalledWith("approvals get --json", {
        quiet: true,
        timeoutMs: 12000,
      });
      expect(fsModule.writeFileSync).not.toHaveBeenCalled();
    });

    it("honours the approvals CLI timeout env override", async () => {
      await withNodeTimeoutEnv({ ALPHACLAW_NODE_APPROVALS_TIMEOUT_MS: "21000" }, async () => {
        const clawCmd = vi.fn(async () => ({
          ok: true,
          stdout: approvalsCliOutput([]),
          stderr: "",
        }));
        const app = createApp({ clawCmd, openclawVersion: kSqliteOpenclawVersion });

        await request(app).get("/api/nodes/exec-approvals");

        expect(clawCmd).toHaveBeenCalledWith("approvals get --json", {
          quiet: true,
          timeoutMs: 21000,
        });
      });
    });
  });
});
