const {
  extractTwidUserId,
  buildCookieString,
  buildApiKey,
  normalizePost,
  fetchListTweets,
  verifyWebSession,
} = require("../../lib/server/x-web-session");

const decode = (apiKey) => Buffer.from(apiKey, "base64").toString("ascii");

const fakeTweet = (over = {}) => ({
  id: "111",
  tweetBy: { userName: "alice", fullName: "Alice A" },
  fullText: "hello $AAPL long-form body",
  createdAt: "2026-07-01T00:00:00.000Z",
  url: "https://x.com/alice/status/111",
  quoted: null,
  ...over,
});

describe("server/x-web-session", () => {
  describe("extractTwidUserId", () => {
    it("pulls the numeric id from every twid shape", () => {
      expect(extractTwidUserId("u=81053338")).toBe("81053338");
      expect(extractTwidUserId('"u=81053338"')).toBe("81053338");
      expect(extractTwidUserId("u%3D81053338")).toBe("81053338");
    });
    it("returns null when there is no numeric id", () => {
      expect(extractTwidUserId("")).toBeNull();
      expect(extractTwidUserId("u=")).toBeNull();
      expect(extractTwidUserId(undefined)).toBeNull();
    });
    it("isolates the twid cookie from a full cookie string (regression)", () => {
      // verifyWebSession passes the whole decoded cookie string. A real
      // auth_token contains 4+ digit runs (here 98823) that must NOT be
      // mistaken for the user id — the twid cookie is the only source.
      const cookie =
        'auth_token=b5ce89c98823cfcc8d6a21e6;ct0=c4d59248e76;twid="u=2081030613508014080";';
      expect(extractTwidUserId(cookie)).toBe("2081030613508014080");
    });
  });

  describe("buildCookieString / buildApiKey", () => {
    it("canonicalizes twid and omits kdt when absent", () => {
      const s = buildCookieString({ authToken: "AT", ct0: "C0", twid: "u=123456" });
      expect(s).toBe('auth_token=AT;ct0=C0;twid="u=123456";');
    });
    it("includes kdt when supplied", () => {
      const s = buildCookieString({ authToken: "AT", ct0: "C0", kdt: "KD", twid: "u=123456" });
      expect(s).toBe('auth_token=AT;ct0=C0;kdt=KD;twid="u=123456";');
    });
    it("round-trips through base64 in buildApiKey", () => {
      const apiKey = buildApiKey({ authToken: "AT", ct0: "C0", twid: "u=123456" });
      expect(decode(apiKey)).toBe('auth_token=AT;ct0=C0;twid="u=123456";');
    });
    it("throws when a required cookie is missing", () => {
      expect(() => buildCookieString({ ct0: "C0", twid: "u=1" })).toThrow(/required/);
      expect(() => buildCookieString({ authToken: "AT", twid: "u=1" })).toThrow(/required/);
      expect(() => buildCookieString({ authToken: "AT", ct0: "C0", twid: "garbage" })).toThrow(
        /required/,
      );
    });
  });

  describe("normalizePost", () => {
    it("flattens a tweet to the skill's shape, using fullText", () => {
      expect(normalizePost(fakeTweet())).toEqual({
        tweet_id: "111",
        author: "@alice",
        author_name: "Alice A",
        text: "hello $AAPL long-form body",
        posted_at: "2026-07-01T00:00:00.000Z",
        url: "https://x.com/alice/status/111",
        quoted: [],
      });
    });
    it("includes a quoted reference when present", () => {
      const post = normalizePost(
        fakeTweet({
          quoted: {
            tweetBy: { userName: "bob" },
            fullText: "quoted body",
            url: "https://x.com/bob/status/222",
          },
        }),
      );
      expect(post.quoted).toEqual([
        { author: "@bob", text: "quoted body", url: "https://x.com/bob/status/222" },
      ]);
    });
  });

  describe("fetchListTweets", () => {
    it("calls list.tweets and returns normalized posts", async () => {
      const calls = [];
      class FakeRettiwt {
        constructor(cfg) {
          calls.push({ cfg });
          this.list = {
            tweets: async (id, count) => {
              calls.push({ id, count });
              return { list: [fakeTweet(), fakeTweet({ id: "222", fullText: "second" })] };
            },
          };
        }
      }
      const out = await fetchListTweets({
        listId: 987,
        maxResults: 5,
        apiKey: "KEY",
        RettiwtCtor: FakeRettiwt,
      });
      expect(calls[0].cfg).toEqual({ apiKey: "KEY" });
      expect(calls[1]).toEqual({ id: "987", count: 5 });
      expect(out.list_id).toBe("987");
      expect(out.count).toBe(2);
      expect(out.posts.map((p) => p.tweet_id)).toEqual(["111", "222"]);
    });
    it("requires listId and apiKey", async () => {
      await expect(fetchListTweets({ apiKey: "K" })).rejects.toThrow(/listId/);
      await expect(fetchListTweets({ listId: "1" })).rejects.toThrow(/apiKey/);
    });
  });

  describe("verifyWebSession", () => {
    const apiKey = buildApiKey({ authToken: "AT", ct0: "C0", twid: "u=81053338" });
    it("resolves the session's own account", async () => {
      class FakeRettiwt {
        constructor() {
          this.user = {
            details: async (id) => ({ id, userName: "me", fullName: "Me Myself" }),
          };
        }
      }
      const r = await verifyWebSession({ apiKey, RettiwtCtor: FakeRettiwt });
      expect(r).toEqual({ userId: "81053338", username: "me", name: "Me Myself" });
    });
    it("throws when the session is dead", async () => {
      class FakeRettiwt {
        constructor() {
          this.user = { details: async () => ({}) };
        }
      }
      await expect(verifyWebSession({ apiKey, RettiwtCtor: FakeRettiwt })).rejects.toThrow(
        /rejected the session/,
      );
    });
  });
});
