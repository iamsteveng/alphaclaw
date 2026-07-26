const express = require("express");
const request = require("supertest");

const {
  registerXListIngestRoutes,
  isWebSessionConfigured,
} = require("../../lib/server/routes/x-list-ingest");

const makeApp = ({ gatewayRpc, authProfiles }) => {
  const app = express();
  app.use(express.json());
  registerXListIngestRoutes({
    app,
    requireAuth: (req, res, next) => next(),
    gatewayRpc,
    authProfiles,
  });
  return app;
};

const withSession = { getProfile: (id) => (id === "x-twitter:web-session" ? { access: "APIKEY" } : null) };
const noSession = { getProfile: () => null };

describe("server/routes/x-list-ingest", () => {
  const OLD_ENV = process.env.X_INGEST_LIST_ID;
  afterEach(() => {
    if (OLD_ENV === undefined) delete process.env.X_INGEST_LIST_ID;
    else process.env.X_INGEST_LIST_ID = OLD_ENV;
  });

  describe("isWebSessionConfigured", () => {
    it("is true only when the profile has an access apiKey", () => {
      expect(isWebSessionConfigured(withSession)).toBe(true);
      expect(isWebSessionConfigured(noSession)).toBe(false);
      expect(isWebSessionConfigured(undefined)).toBe(false);
      expect(isWebSessionConfigured({ getProfile: () => ({}) })).toBe(false);
    });
  });

  describe("GET /api/x-list-ingest/status", () => {
    it("reports webSessionConfigured=true when cookies are stored", async () => {
      process.env.X_INGEST_LIST_ID = "123";
      const app = makeApp({
        gatewayRpc: vi.fn(async () => ({ jobs: [] })),
        authProfiles: withSession,
      });
      const res = await request(app).get("/api/x-list-ingest/status");
      expect(res.body).toMatchObject({ ok: true, envVarSet: true, listId: "123", webSessionConfigured: true });
    });

    it("reports webSessionConfigured=false when no cookies, even if gateway errors", async () => {
      process.env.X_INGEST_LIST_ID = "123";
      const app = makeApp({
        gatewayRpc: vi.fn(async () => { throw new Error("gateway down"); }),
        authProfiles: noSession,
      });
      const res = await request(app).get("/api/x-list-ingest/status");
      expect(res.body).toMatchObject({ ok: true, webSessionConfigured: false, job: null });
    });
  });

  describe("POST /api/x-list-ingest/ensure", () => {
    it("refuses to register without a web session", async () => {
      process.env.X_INGEST_LIST_ID = "123";
      const gatewayRpc = vi.fn(async () => ({ jobs: [] }));
      const app = makeApp({ gatewayRpc, authProfiles: noSession });
      const res = await request(app).post("/api/x-list-ingest/ensure").send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/web session not configured/i);
      expect(gatewayRpc).not.toHaveBeenCalled(); // gated before touching the gateway
    });

    it("still refuses when the list id env var is missing", async () => {
      delete process.env.X_INGEST_LIST_ID;
      const app = makeApp({ gatewayRpc: vi.fn(), authProfiles: withSession });
      const res = await request(app).post("/api/x-list-ingest/ensure").send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/X_INGEST_LIST_ID/);
    });

    it("registers the cron when both prerequisites are met", async () => {
      process.env.X_INGEST_LIST_ID = "123";
      const gatewayRpc = vi.fn(async (method) => {
        if (method === "cron.list") return { jobs: [] };
        if (method === "cron.add") return { id: "job-1" };
        if (method === "cron.update") return {};
        return {};
      });
      // second cron.list (after add) should surface the job
      let listCalls = 0;
      gatewayRpc.mockImplementation(async (method, params) => {
        if (method === "cron.list") {
          listCalls += 1;
          return { jobs: listCalls === 1 ? [] : [{ id: "job-1", name: "x-list-ingest", enabled: true }] };
        }
        if (method === "cron.add") return { id: "job-1" };
        return {};
      });
      const app = makeApp({ gatewayRpc, authProfiles: withSession });
      const res = await request(app).post("/api/x-list-ingest/ensure").send({});
      expect(res.body).toMatchObject({ ok: true, registered: true, jobId: "job-1" });
      expect(gatewayRpc).toHaveBeenCalledWith("cron.add", expect.objectContaining({ name: "x-list-ingest" }), expect.anything());
    });
  });
});
