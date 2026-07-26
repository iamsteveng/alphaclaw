const { parseArgs } = require("../../bin/x-list-crawl");

describe("bin/x-list-crawl parseArgs", () => {
  it("reads the list id and default max", () => {
    expect(parseArgs(["1234567890"])).toEqual({ listId: "1234567890", maxResults: 10 });
  });
  it("honors --max / -n", () => {
    expect(parseArgs(["123", "--max", "25"]).maxResults).toBe(25);
    expect(parseArgs(["123", "-n", "5"]).maxResults).toBe(5);
  });
  it("falls back to 10 for a non-positive or invalid max", () => {
    expect(parseArgs(["123", "--max", "0"]).maxResults).toBe(10);
    expect(parseArgs(["123", "--max", "nope"]).maxResults).toBe(10);
  });
  it("flags --help", () => {
    expect(parseArgs(["--help"]).help).toBe(true);
  });
});
