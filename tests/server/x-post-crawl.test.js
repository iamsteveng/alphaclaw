const { parseArgs } = require("../../bin/x-post-crawl");

describe("bin/x-post-crawl parseArgs", () => {
  it("takes the URL as the positional arg", () => {
    expect(parseArgs(["https://x.com/h/status/123"])).toEqual({
      url: "https://x.com/h/status/123",
    });
  });
  it("flags --help", () => {
    expect(parseArgs(["--help"]).help).toBe(true);
  });
  it("keeps the first positional as the url", () => {
    expect(parseArgs(["123", "456"]).url).toBe("123");
  });
});
