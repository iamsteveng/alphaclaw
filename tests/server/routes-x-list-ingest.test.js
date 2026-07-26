const express = require("express");
const request = require("supertest");

const {
  registerXListIngestRoutes,
  isWebSessionConfigured,
  parseListId,
  extractListIdFromJob,
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
  describe("parseListId", () => {
    it("accepts a numeric string and trims it", () => {
      expect(parseListId("1356490823949451264")).toBe("1356490823949451264");
      expect(parseListId("  123  ")).toBe("123");
    });
    it("rejects non-numeric, empty, or missing input", () => {
      expect(parseListId("")).toBeNull();
      expect(parseListId("abc")).toBeNull();
      expect(parseListId("12a3")).toBeNull();
      expect(parseListId(undefined)).toBeNull();
    });
  });

  describe("extractListIdFromJob", () => {
    it("recovers the id from payload.message or a flat message", () => {
      expect(extractListIdFromJob({ payload: { message: "Run the x-list-ingest skill for X list ID 999." } })).toBe("999");
      expect(extractListIdFromJob({ message: "… for X list ID 123." })).toBe("123");
    });
    it("returns null when the message is absent or unparseable", () => {
      expect(extractListIdFromJob({})).toBeNull();
      expect(extractListIdFromJob(null)).toBeNull();
      expect(extractListIdFromJob({ payload: { message: "no id here" } })).toBeNull();
    });
  });

  describe("isWebSessionConfigured", () => {
    it("is true only when the profile has an access apiKey", () => {
      expect(isWebSessionConfigured(withSession)).toBe(true);
      expect(isWebSessionConfigured(noSession)).toBe(false);
      expect(isWebSessionConfigured(undefined)).toBe(false);
    });
  });

  describe("GET /api/x-list-ingest/status", () => {
    it("recovers the current list ID from the registered job", async () => {
      const app = makeApp({
        gatewayRpc: vi.fn(async () => ({
          jobs: [{ name: "x-list-ingest", cron: "0 */2 * * *", enabled: true, payload: { message: "… for X list ID 555." } }],
        })),
        authProfiles: withSession,
      });
      const res = await request(app).get("/api/x-list-ingest/status");
      expect(res.body).toMatchObject({ ok: true, listId: "555", webSessionConfigured: true });
    });

    it("returns listId=null when unregistered, even if the gateway errors", async () => {
      const app = makeApp({
        gatewayRpc: vi.fn(async () => { throw new Error("gateway down"); }),
        authProfiles: noSession,
      });
      const res = await request(app).get("/api/x-list-ingest/status");
      expect(res.body).toMatchObject({ ok: true, listId: null, webSessionConfigured: false, job: null });
    });
  });

  describe("POST /api/x-list-ingest/ensure", () => {
    it("requires a numeric list ID in the body", async () => {
      const gatewayRpc = vi.fn();
      const app = makeApp({ gatewayRpc, authProfiles: withSession });
      const res = await request(app).post("/api/x-list-ingest/ensure").send({ listId: "not-a-number" });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/numeric X list ID/i);
      expect(gatewayRpc).not.toHaveBeenCalled();
    });

    it("refuses to register without a web session", async () => {
      const gatewayRpc = vi.fn(async () => ({ jobs: [] }));
      const app = makeApp({ gatewayRpc, authProfiles: noSession });
      const res = await request(app).post("/api/x-list-ingest/ensure").send({ listId: "123" });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/web session not configured/i);
      expect(gatewayRpc).not.toHaveBeenCalled();
    });

    it("registers with the body list ID and a 2-hour schedule", async () => {
      let listCalls = 0;
      const gatewayRpc = vi.fn(async (method) => {
        if (method === "cron.list") {
          listCalls += 1;
          return { jobs: listCalls === 1 ? [] : [{ id: "job-1", name: "x-list-ingest", enabled: true }] };
        }
        if (method === "cron.add") return { id: "job-1" };
        return {};
      });
      const app = makeApp({ gatewayRpc, authProfiles: withSession });
      const res = await request(app).post("/api/x-list-ingest/ensure").send({ listId: "1356490823949451264" });
      expect(res.body).toMatchObject({ ok: true, registered: true, jobId: "job-1" });
      const addCall = gatewayRpc.mock.calls.find(([m]) => m === "cron.add");
      expect(addCall[1].schedule.expr).toBe("0 */2 * * *");
      expect(addCall[1].payload.message).toContain("1356490823949451264");
    });
  });
});
