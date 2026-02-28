const express = require("express");
const http = require("http");
const httpProxy = require("http-proxy");
const path = require("path");
const fs = require("fs");

const constants = require("./server/constants");
const {
  parseJsonFromNoisyOutput,
  normalizeOnboardingModels,
  resolveModelProvider,
  resolveGithubRepoUrl,
  createPkcePair,
  parseCodexAuthorizationInput,
  getCodexAccountId,
  getBaseUrl,
  getApiEnableUrl,
  readGoogleCredentials,
  getClientKey,
} = require("./server/helpers");
const {
  initWebhooksDb,
  insertRequest,
  getRequests,
  getRequestById,
  getHookSummaries,
} = require("./server/webhooks-db");
const { createWebhookMiddleware } = require("./server/webhook-middleware");
const {
  readEnvFile,
  writeEnvFile,
  reloadEnv,
  startEnvWatcher,
} = require("./server/env");
const {
  gatewayEnv,
  isOnboarded,
  isGatewayRunning,
  startGateway,
  restartGateway: restartGatewayWithReload,
  attachGatewaySignalHandlers,
  ensureGatewayProxyConfig,
  syncChannelConfig,
  getChannelStatus,
} = require("./server/gateway");
const { createCommands } = require("./server/commands");
const { createAuthProfiles } = require("./server/auth-profiles");
const { createLoginThrottle } = require("./server/login-throttle");
const { createOpenclawVersionService } = require("./server/openclaw-version");
const { createAlphaclawVersionService } = require("./server/alphaclaw-version");
const {
  createRestartRequiredState,
} = require("./server/restart-required-state");
const { syncBootstrapPromptFiles } = require("./server/onboarding/workspace");
const { createTelegramApi } = require("./server/telegram-api");

const { registerAuthRoutes } = require("./server/routes/auth");
const { registerPageRoutes } = require("./server/routes/pages");
const { registerModelRoutes } = require("./server/routes/models");
const { registerOnboardingRoutes } = require("./server/routes/onboarding");
const { registerSystemRoutes } = require("./server/routes/system");
const { registerPairingRoutes } = require("./server/routes/pairings");
const { registerCodexRoutes } = require("./server/routes/codex");
const { registerGoogleRoutes } = require("./server/routes/google");
const { registerProxyRoutes } = require("./server/routes/proxy");
const { registerTelegramRoutes } = require("./server/routes/telegram");
const { registerWebhookRoutes } = require("./server/routes/webhooks");

const { PORT, GATEWAY_URL, kTrustProxyHops, SETUP_API_PREFIXES } = constants;

startEnvWatcher();
attachGatewaySignalHandlers();

const app = express();
app.set("trust proxy", kTrustProxyHops);
app.use(["/webhook", "/hooks"], express.raw({ type: "*/*", limit: "5mb" }));
app.use(express.json());

const proxy = httpProxy.createProxyServer({
  target: GATEWAY_URL,
  ws: true,
  changeOrigin: true,
});
proxy.on("error", (err, req, res) => {
  if (res && res.writeHead) {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Gateway unavailable" }));
  }
});

const authProfiles = createAuthProfiles();
const loginThrottle = { ...createLoginThrottle(), getClientKey };
const { shellCmd, clawCmd, gogCmd } = createCommands({ gatewayEnv });
const restartGateway = () => restartGatewayWithReload(reloadEnv);
const openclawVersionService = createOpenclawVersionService({
  gatewayEnv,
  restartGateway,
  isOnboarded,
});
const alphaclawVersionService = createAlphaclawVersionService();
const restartRequiredState = createRestartRequiredState({ isGatewayRunning });

const { requireAuth, isAuthorizedRequest } = registerAuthRoutes({
  app,
  loginThrottle,
});
app.use(express.static(path.join(__dirname, "public")));
initWebhooksDb({
  rootDir: constants.kRootDir,
  pruneDays: constants.kWebhookPruneDays,
});
const webhookMiddleware = createWebhookMiddleware({
  gatewayUrl: constants.GATEWAY_URL,
  insertRequest,
  maxPayloadBytes: constants.kMaxPayloadBytes,
});

registerPageRoutes({ app, requireAuth, isGatewayRunning });
registerModelRoutes({
  app,
  shellCmd,
  gatewayEnv,
  parseJsonFromNoisyOutput,
  normalizeOnboardingModels,
});
registerOnboardingRoutes({
  app,
  fs,
  constants,
  shellCmd,
  gatewayEnv,
  writeEnvFile,
  reloadEnv,
  isOnboarded,
  resolveGithubRepoUrl,
  resolveModelProvider,
  hasCodexOauthProfile: authProfiles.hasCodexOauthProfile,
  ensureGatewayProxyConfig,
  getBaseUrl,
  startGateway,
});
registerSystemRoutes({
  app,
  fs,
  readEnvFile,
  writeEnvFile,
  reloadEnv,
  kKnownVars: constants.kKnownVars,
  kKnownKeys: constants.kKnownKeys,
  kSystemVars: constants.kSystemVars,
  syncChannelConfig,
  isGatewayRunning,
  isOnboarded,
  getChannelStatus,
  openclawVersionService,
  alphaclawVersionService,
  clawCmd,
  restartGateway,
  OPENCLAW_DIR: constants.OPENCLAW_DIR,
  restartRequiredState,
});
registerPairingRoutes({ app, clawCmd, isOnboarded });
registerCodexRoutes({
  app,
  createPkcePair,
  parseCodexAuthorizationInput,
  getCodexAccountId,
  authProfiles,
});
registerGoogleRoutes({
  app,
  fs,
  isGatewayRunning,
  gogCmd,
  getBaseUrl,
  readGoogleCredentials,
  getApiEnableUrl,
  constants,
});
const telegramApi = createTelegramApi(() => process.env.TELEGRAM_BOT_TOKEN);
const doSyncPromptFiles = () =>
  syncBootstrapPromptFiles({ fs, workspaceDir: constants.WORKSPACE_DIR });
registerTelegramRoutes({
  app,
  telegramApi,
  syncPromptFiles: doSyncPromptFiles,
});
registerWebhookRoutes({
  app,
  fs,
  constants,
  getBaseUrl,
  shellCmd,
  webhooksDb: {
    getRequests,
    getRequestById,
    getHookSummaries,
  },
  restartRequiredState,
});
registerProxyRoutes({
  app,
  proxy,
  SETUP_API_PREFIXES,
  requireAuth,
  webhookMiddleware,
});

const server = http.createServer(app);
server.on("upgrade", (req, socket, head) => {
  const requestUrl = new URL(
    req.url || "/",
    `http://${req.headers.host || "localhost"}`,
  );
  if (requestUrl.pathname.startsWith("/openclaw")) {
    const upgradeReq = {
      ...req,
      path: requestUrl.pathname,
      query: Object.fromEntries(requestUrl.searchParams.entries()),
    };
    if (!isAuthorizedRequest(upgradeReq)) {
      socket.write(
        "HTTP/1.1 401 Unauthorized\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nUnauthorized",
      );
      socket.destroy();
      return;
    }
  }
  proxy.ws(req, socket, head);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[alphaclaw] Express listening on :${PORT}`);
  doSyncPromptFiles();
  if (isOnboarded()) {
    reloadEnv();
    syncChannelConfig(readEnvFile());
    ensureGatewayProxyConfig(null);
    startGateway();
  } else {
    console.log("[alphaclaw] Awaiting onboarding via Setup UI");
  }
});
