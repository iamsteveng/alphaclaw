const registerProxyRoutes = ({
  app,
  proxy,
  SETUP_API_PREFIXES,
  requireAuth,
  webhookMiddleware,
}) => {
  app.all("/openclaw", requireAuth, (req, res) => {
    req.url = "/";
    proxy.web(req, res);
  });
  app.all("/openclaw/*", requireAuth, (req, res) => {
    req.url = req.url.replace(/^\/openclaw/, "");
    proxy.web(req, res);
  });
  app.all("/assets/*", requireAuth, (req, res) => proxy.web(req, res));

  app.all("/hooks/*", webhookMiddleware);
  app.all("/webhook/*", webhookMiddleware);

  app.all("/api/*", (req, res) => {
    if (SETUP_API_PREFIXES.some((p) => req.path.startsWith(p))) return;
    proxy.web(req, res);
  });
};

module.exports = { registerProxyRoutes };
