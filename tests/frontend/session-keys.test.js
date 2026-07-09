import { describe, expect, it } from "vitest";
import {
  getDestinationFromSession,
  getSessionChannelForIcon,
  getSessionDisplayLabel,
  getSessionKind,
  isDestinationSessionKey,
  kDestinationSessionFilter,
  parseChannelFromSessionKey,
} from "../../lib/public/js/lib/session-keys.js";

describe("session-keys display helpers", () => {
  it("getSessionDisplayLabel renders main thread from key", () => {
    expect(
      getSessionDisplayLabel({
        key: "agent:main:main",
      }),
    ).toBe("Main Thread");
  });

  it("getSessionDisplayLabel renders bare main key as Main Thread", () => {
    expect(
      getSessionDisplayLabel({
        key: "main",
      }),
    ).toBe("Main Thread");
  });

  it("getSessionDisplayLabel renders telegram direct as Direct message", () => {
    expect(
      getSessionDisplayLabel({
        key: "agent:main:telegram:default:direct:1050",
      }),
    ).toBe("Direct message");
  });

  it("getSessionDisplayLabel renders non-telegram direct with id", () => {
    expect(
      getSessionDisplayLabel({
        key: "agent:main:slack:direct:u02r12345",
      }),
    ).toBe("Direct u02r12345");
  });

  it("getSessionDisplayLabel uses enriched topic/group names when present", () => {
    expect(
      getSessionDisplayLabel({
        key: "agent:main:telegram:group:-1003709908795:topic:4011",
        topicName: "Rosebud",
        groupName: "AlphaClaw",
      }),
    ).toBe("Rosebud - AlphaClaw");
  });

  it("getSessionDisplayLabel falls back to topic id/group id when names missing", () => {
    expect(
      getSessionDisplayLabel({
        key: "agent:main:telegram:group:-1003709908795:topic:4011",
      }),
    ).toBe("Topic 4011 - -1003709908795");
  });

  it("getSessionDisplayLabel renders doctor runs with sequence number", () => {
    expect(
      getSessionDisplayLabel({
        key: "agent:main:doctor:1",
      }),
    ).toBe("Doctor Run #1");
  });

  it("getSessionKind classifies session keys", () => {
    expect(getSessionKind("agent:main:main")).toBe("main");
    expect(getSessionKind("agent:main:telegram:group:-1:topic:9")).toBe("topic");
    expect(getSessionKind("agent:main:telegram:direct:7")).toBe("direct");
    expect(getSessionKind("agent:main:slash:foo")).toBe("slash");
    expect(getSessionKind("agent:main:subagent:worker:123")).toBe("subagent");
    expect(getSessionKind("agent:main:discord:channel:987654")).toBe("channel");
    expect(getSessionKind("agent:main:custom:thing")).toBe("other");
  });

  it("getSessionDisplayLabel renders Discord guild channel with id", () => {
    expect(
      getSessionDisplayLabel({
        key: "agent:main:discord:channel:987654",
      }),
    ).toBe("Discord Channel 987654");
  });

  it("getSessionDisplayLabel renders Discord DM using existing direct fallback", () => {
    expect(
      getSessionDisplayLabel({
        key: "agent:main:discord:direct:123456",
      }),
    ).toBe("Direct 123456");
  });

  it("parseChannelFromSessionKey detects telegram in key", () => {
    expect(parseChannelFromSessionKey("agent:main:telegram:direct:1")).toBe(
      "telegram",
    );
  });

  it("parseChannelFromSessionKey detects discord in key", () => {
    expect(parseChannelFromSessionKey("agent:main:discord:channel:987654")).toBe(
      "discord",
    );
  });

  it("getSessionChannelForIcon uses replyChannel when channel missing", () => {
    expect(
      getSessionChannelForIcon({
        key: "agent:main:main",
        replyChannel: "telegram",
      }),
    ).toBe("telegram");
  });

  it("isDestinationSessionKey matches Discord guild channel keys", () => {
    expect(isDestinationSessionKey("agent:main:discord:channel:987654")).toBe(
      true,
    );
  });

  it("isDestinationSessionKey still matches Discord DM keys", () => {
    expect(isDestinationSessionKey("agent:main:discord:direct:123456")).toBe(
      true,
    );
  });

  it("kDestinationSessionFilter includes a Discord guild channel session row", () => {
    expect(
      kDestinationSessionFilter({
        key: "agent:main:discord:channel:987654",
        replyChannel: "discord",
        replyTo: "987654",
      }),
    ).toBe(true);
  });

  it("getDestinationFromSession resolves a Discord guild channel session row", () => {
    expect(
      getDestinationFromSession({
        key: "agent:main:discord:channel:987654",
        replyChannel: "discord",
        replyTo: "987654",
      }),
    ).toEqual({ channel: "discord", to: "987654", agentId: "main" });
  });
});
