const kDiscordApiBase = "https://discord.com/api/v10";

const createDiscordApi = (getToken) => {
  const call = async (path, { method = "GET", body } = {}) => {
    const token = typeof getToken === "function" ? getToken() : getToken;
    if (!token) throw new Error("DISCORD_BOT_TOKEN is not set");
    const res = await fetch(`${kDiscordApiBase}${path}`, {
      method,
      headers: {
        Authorization: `Bot ${token}`,
        "Content-Type": "application/json",
      },
      ...(body != null ? { body: JSON.stringify(body) } : {}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data?.message || `Discord API error: ${method} ${path}`);
      err.discordStatusCode = res.status;
      throw err;
    }
    return data;
  };

  const createDmChannel = (userId) =>
    call("/users/@me/channels", {
      method: "POST",
      body: { recipient_id: String(userId || "") },
    });

  const sendMessage = (channelId, content) =>
    call(`/channels/${channelId}/messages`, {
      method: "POST",
      body: { content: String(content || "") },
    });

  const sendDirectMessage = async (userId, content) => {
    const channel = await createDmChannel(userId);
    return sendMessage(channel?.id, content);
  };

  return {
    createDmChannel,
    sendMessage,
    sendDirectMessage,
  };
};

module.exports = { createDiscordApi };
