const {
  extractTwidUserId,
  buildCookieString,
  buildApiKey,
  normalizePost,
  parseTweetId,
  findArticle,
  reconstructArticle,
  normalizePostDetailed,
  fetchPostByUrl,
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

  // ── Single post / article by URL ──
  describe("parseTweetId", () => {
    it("extracts the id from x.com / twitter.com status URLs", () => {
      expect(parseTweetId("https://x.com/a16z/status/2080669591349727628")).toBe("2080669591349727628");
      expect(parseTweetId("https://twitter.com/h/status/123?s=20")).toBe("123");
    });
    it("accepts a bare numeric id", () => {
      expect(parseTweetId("  123456  ")).toBe("123456");
    });
    it("rejects non-status URLs and junk", () => {
      expect(parseTweetId("https://x.com/a16z")).toBeNull();
      expect(parseTweetId("not a url")).toBeNull();
      expect(parseTweetId("")).toBeNull();
    });
  });

  // Article on a *quoted* status — exercises the recursive search.
  const articleTweet = (over = {}) =>
    fakeTweet({
      id: "999",
      tweetBy: { userName: "a16z", fullName: "a16z" },
      fullText: "teaser tweet text",
      url: "https://x.com/a16z/status/999",
      _raw: {
        quoted_status_result: { result: { article: { article_results: { result: {
          title: "Renting is stressful",
          preview_text: "a short preview",
          content_state: { blocks: [{ text: "Block one." }, { text: "Block two." }, {}] },
        } } } } },
      },
      ...over,
    });

  describe("findArticle / reconstructArticle", () => {
    it("finds an article nested on a quoted status", () => {
      const art = findArticle(articleTweet()._raw);
      expect(art?.title).toBe("Renting is stressful");
    });
    it("returns null when there is no article", () => {
      expect(findArticle(fakeTweet()._raw ?? {})).toBeNull();
    });
    it("reconstructs the body by joining block text", () => {
      const art = findArticle(articleTweet()._raw);
      expect(reconstructArticle(art)).toEqual({
        title: "Renting is stressful",
        preview: "a short preview",
        body: "Block one.\nBlock two.\n",
        blocks: 3,
      });
    });
  });

  describe("normalizePostDetailed", () => {
    it("marks a plain post is_article=false", () => {
      const out = normalizePostDetailed(fakeTweet());
      expect(out.is_article).toBe(false);
      expect(out.text).toContain("long-form body");
    });
    it("attaches the full article body for an article post", () => {
      const out = normalizePostDetailed(articleTweet());
      expect(out).toMatchObject({
        tweet_id: "999",
        author: "@a16z",
        is_article: true,
        article_title: "Renting is stressful",
        article_preview: "a short preview",
        article_body: "Block one.\nBlock two.\n",
        article_blocks: 3,
      });
    });
  });

  describe("fetchPostByUrl", () => {
    const makeCtor = (tweet) =>
      class {
        constructor(cfg) { this.cfg = cfg; this.tweet = { details: async (id) => ({ ...tweet, id }) }; }
      };
    it("parses the id from a URL, fetches, and returns the detailed post", async () => {
      const out = await fetchPostByUrl({
        url: "https://x.com/a16z/status/999",
        apiKey: "K",
        RettiwtCtor: makeCtor(articleTweet()),
      });
      expect(out.tweet_id).toBe("999");
      expect(out.is_article).toBe(true);
    });
    it("throws on an unparseable URL and on a missing apiKey", async () => {
      await expect(fetchPostByUrl({ url: "https://x.com/a16z", apiKey: "K", RettiwtCtor: makeCtor(fakeTweet()) }))
        .rejects.toThrow(/could not parse a tweet ID/);
      await expect(fetchPostByUrl({ url: "https://x.com/a16z/status/1" }))
        .rejects.toThrow(/apiKey/);
    });
  });
});
