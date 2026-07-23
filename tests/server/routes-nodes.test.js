const express = require("express");
const request = require("supertest");

const { registerNodeRoutes } = require("../../lib/server/routes/nodes");

const kNodeTimeoutEnvNames = [
  "ALPHACLAW_NODE_ROUTE_TIMEOUT_MS",
  "ALPHACLAW_NODES_STATUS_TIMEOUT_MS",
  "ALPHACLAW_NODES_PENDING_TIMEOUT_MS",
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

const createApp = ({ clawCmd, fsModule } = {}) => {
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
  });
  return app;
};

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
});
