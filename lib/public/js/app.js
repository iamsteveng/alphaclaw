import { h, render } from "https://esm.sh/preact";
import { useState, useEffect, useRef, useCallback } from "https://esm.sh/preact/hooks";
import htm from "https://esm.sh/htm";
import { Router, Route, Switch, useLocation } from "https://esm.sh/wouter-preact";
import {
  fetchStatus,
  fetchPairings,
  approvePairing,
  rejectPairing,
  fetchDevicePairings,
  approveDevice,
  rejectDevice,
  fetchOnboardStatus,
  fetchAuthStatus,
  logout,
  fetchDashboardUrl,
  updateSyncCron,
  fetchAlphaclawVersion,
  updateAlphaclaw,
  fetchRestartStatus,
  restartGateway,
} from "./lib/api.js";
import { usePolling } from "./hooks/usePolling.js";
import { Gateway } from "./components/gateway.js";
import { Channels, ALL_CHANNELS } from "./components/channels.js";
import { Pairings } from "./components/pairings.js";
import { DevicePairings } from "./components/device-pairings.js";
import { Google } from "./components/google.js";
import { Features } from "./components/features.js";
import { Providers } from "./components/providers.js";
import { Welcome } from "./components/welcome.js";
import { Envars } from "./components/envars.js";
import { Webhooks } from "./components/webhooks.js";
import { ToastContainer, showToast } from "./components/toast.js";
import { TelegramWorkspace } from "./components/telegram-workspace.js";
import { ChevronDownIcon } from "./components/icons.js";
import { UpdateActionButton } from "./components/update-action-button.js";
import { GlobalRestartBanner } from "./components/global-restart-banner.js";
const html = htm.bind(h);
const kDefaultUiTab = "general";

const getHashPath = () => {
  const hash = window.location.hash.replace(/^#/, "");
  if (!hash) return `/${kDefaultUiTab}`;
  return hash.startsWith("/") ? hash : `/${hash}`;
};

const useHashLocation = () => {
  const [location, setLocationState] = useState(getHashPath);

  useEffect(() => {
    const onHashChange = () => setLocationState(getHashPath());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const setLocation = useCallback((to) => {
    const normalized = to.startsWith("/") ? to : `/${to}`;
    const nextHash = `#${normalized}`;
    if (window.location.hash !== nextHash) {
      window.location.hash = normalized;
      return;
    }
    setLocationState(normalized);
  }, []);

  return [location, setLocation];
};

const RouteRedirect = ({ to }) => {
  const [, setLocation] = useLocation();
  useEffect(() => {
    setLocation(to);
  }, [to, setLocation]);
  return null;
};

const GeneralTab = ({
  onSwitchTab,
  onNavigate,
  isActive,
  restartingGateway,
  onRestartGateway,
}) => {
  const [googleKey, setGoogleKey] = useState(0);
  const [dashboardLoading, setDashboardLoading] = useState(false);

  const statusPoll = usePolling(fetchStatus, 15000);
  const status = statusPoll.data;
  const gatewayStatus = status?.gateway ?? null;
  const channels = status?.channels ?? null;
  const repo = status?.repo || null;
  const syncCron = status?.syncCron || null;
  const openclawVersion = status?.openclawVersion || null;
  const [syncCronEnabled, setSyncCronEnabled] = useState(true);
  const [syncCronSchedule, setSyncCronSchedule] = useState("0 * * * *");
  const [savingSyncCron, setSavingSyncCron] = useState(false);
  const [syncCronChoice, setSyncCronChoice] = useState("0 * * * *");

  const hasUnpaired = ALL_CHANNELS.some((ch) => {
    const info = channels?.[ch];
    return info && info.status !== "paired";
  });

  const pairingsPoll = usePolling(
    async () => {
      const d = await fetchPairings();
      return d.pending || [];
    },
    1000,
    { enabled: hasUnpaired && gatewayStatus === "running" },
  );
  const pending = pairingsPoll.data || [];

  // Poll status faster when gateway isn't running yet
  useEffect(() => {
    if (!gatewayStatus || gatewayStatus !== "running") {
      const id = setInterval(statusPoll.refresh, 3000);
      return () => clearInterval(id);
    }
  }, [gatewayStatus, statusPoll.refresh]);

  const refreshAfterAction = () => {
    setTimeout(pairingsPoll.refresh, 500);
    setTimeout(pairingsPoll.refresh, 2000);
    setTimeout(statusPoll.refresh, 3000);
  };

  const handleApprove = async (id, channel) => {
    await approvePairing(id, channel);
    refreshAfterAction();
  };

  const handleReject = async (id, channel) => {
    await rejectPairing(id, channel);
    refreshAfterAction();
  };

  const devicePoll = usePolling(
    async () => {
      const d = await fetchDevicePairings();
      return d.pending || [];
    },
    2000,
    { enabled: gatewayStatus === "running" },
  );
  const devicePending = devicePoll.data || [];

  const handleDeviceApprove = async (id) => {
    await approveDevice(id);
    setTimeout(devicePoll.refresh, 500);
    setTimeout(devicePoll.refresh, 2000);
  };

  const handleDeviceReject = async (id) => {
    await rejectDevice(id);
    setTimeout(devicePoll.refresh, 500);
    setTimeout(devicePoll.refresh, 2000);
  };

  const fullRefresh = () => {
    statusPoll.refresh();
    pairingsPoll.refresh();
    devicePoll.refresh();
    setGoogleKey((k) => k + 1);
  };

  useEffect(() => {
    if (!isActive) return;
    fullRefresh();
  }, [isActive]);

  useEffect(() => {
    if (!syncCron) return;
    setSyncCronEnabled(syncCron.enabled !== false);
    setSyncCronSchedule(syncCron.schedule || "0 * * * *");
    setSyncCronChoice(
      syncCron.enabled === false
        ? "disabled"
        : syncCron.schedule || "0 * * * *",
    );
  }, [syncCron?.enabled, syncCron?.schedule]);

  const saveSyncCronSettings = async ({
    enabled = syncCronEnabled,
    schedule = syncCronSchedule,
  }) => {
    if (savingSyncCron) return;
    setSavingSyncCron(true);
    try {
      const data = await updateSyncCron({ enabled, schedule });
      if (!data.ok)
        throw new Error(data.error || "Could not save sync settings");
      showToast("Sync schedule updated", "success");
      statusPoll.refresh();
    } catch (err) {
      showToast(err.message || "Could not save sync settings", "error");
    }
    setSavingSyncCron(false);
  };

  const syncCronStatusText = syncCronEnabled ? "Enabled" : "Disabled";

  return html`
    <div class="space-y-4">
      <${Gateway}
        status=${gatewayStatus}
        openclawVersion=${openclawVersion}
        restarting=${restartingGateway}
        onRestart=${onRestartGateway}
      />
      <${Channels} channels=${channels} onSwitchTab=${onSwitchTab} onNavigate=${onNavigate} />
      <${Pairings}
        pending=${pending}
        channels=${channels}
        visible=${hasUnpaired}
        onApprove=${handleApprove}
        onReject=${handleReject}
      />
      <${Features} onSwitchTab=${onSwitchTab} />
      <${Google} key=${googleKey} gatewayStatus=${gatewayStatus} />

      ${repo &&
      html`
        <div class="bg-surface border border-border rounded-xl p-4">
          <div class="flex items-center justify-between gap-3">
            <div class="flex items-center gap-2 min-w-0">
              <svg
                class="w-4 h-4 text-gray-400"
                viewBox="0 0 16 16"
                fill="currentColor"
              >
                <path
                  d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"
                />
              </svg>
              <a
                href="https://github.com/${repo}"
                target="_blank"
                class="text-sm text-gray-400 hover:text-gray-200 transition-colors truncate"
                >${repo}</a
              >
            </div>
            <div class="flex items-center gap-2 shrink-0">
              <span class="text-xs text-gray-400">Auto-sync</span>
              <div class="relative">
                <select
                  value=${syncCronChoice}
                  onchange=${(e) => {
                    const nextChoice = e.target.value;
                    setSyncCronChoice(nextChoice);
                    const nextEnabled = nextChoice !== "disabled";
                    const nextSchedule = nextEnabled
                      ? nextChoice
                      : syncCronSchedule;
                    setSyncCronEnabled(nextEnabled);
                    setSyncCronSchedule(nextSchedule);
                    saveSyncCronSettings({
                      enabled: nextEnabled,
                      schedule: nextSchedule,
                    });
                  }}
                  disabled=${savingSyncCron}
                  class="appearance-none bg-black/30 border border-border rounded-lg pl-2.5 pr-9 py-1.5 text-xs text-gray-300 ${savingSyncCron
                    ? "opacity-50 cursor-not-allowed"
                    : ""}"
                  title=${syncCron?.installed === false
                    ? "Not Installed Yet"
                    : syncCronStatusText}
                >
                  <option value="disabled">Disabled</option>
                  <option value="*/30 * * * *">Every 30 min</option>
                  <option value="0 * * * *">Hourly</option>
                  <option value="0 0 * * *">Daily</option>
                </select>
                <${ChevronDownIcon}
                  className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-500"
                />
              </div>
            </div>
          </div>
        </div>
      `}

      <div class="bg-surface border border-border rounded-xl p-4">
        <div class="flex items-center justify-between">
          <div>
            <h2 class="font-semibold text-sm">OpenClaw Gateway Dashboard</h2>
          </div>
          <${UpdateActionButton}
            onClick=${async () => {
              if (dashboardLoading) return;
              setDashboardLoading(true);
              try {
                const data = await fetchDashboardUrl();
                console.log("[dashboard] response:", JSON.stringify(data));
                window.open(data.url || "/openclaw", "_blank");
              } catch (err) {
                console.error("[dashboard] error:", err);
                window.open("/openclaw", "_blank");
              }
              setDashboardLoading(false);
            }}
            loading=${dashboardLoading}
            warning=${false}
            idleLabel="Open"
            loadingLabel="Opening..."
          />
        </div>
        <${DevicePairings}
          pending=${devicePending}
          onApprove=${handleDeviceApprove}
          onReject=${handleDeviceReject}
        />
      </div>

      <p class="text-center text-gray-600 text-xs">
        <a
          href="#"
          onclick=${(e) => {
            e.preventDefault();
            fullRefresh();
          }}
          class="text-gray-500 hover:text-gray-300"
          >Refresh all</a
        >
      </p>
    </div>
  `;
};

const App = () => {
  const [onboarded, setOnboarded] = useState(null);
  const [location, setLocation] = useLocation();
  const [acVersion, setAcVersion] = useState(null);
  const [acLatest, setAcLatest] = useState(null);
  const [acHasUpdate, setAcHasUpdate] = useState(false);
  const [acUpdating, setAcUpdating] = useState(false);
  const [acDismissed, setAcDismissed] = useState(false);
  const [authEnabled, setAuthEnabled] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [mobileTopbarScrolled, setMobileTopbarScrolled] = useState(false);
  const [restartRequired, setRestartRequired] = useState(false);
  const [restartingGateway, setRestartingGateway] = useState(false);
  const menuRef = useRef(null);

  const closeMenu = useCallback((e) => {
    if (menuRef.current && !menuRef.current.contains(e.target)) {
      setMenuOpen(false);
    }
  }, []);

  useEffect(() => {
    if (menuOpen) {
      document.addEventListener("click", closeMenu, true);
      return () => document.removeEventListener("click", closeMenu, true);
    }
  }, [menuOpen, closeMenu]);

  useEffect(() => {
    fetchOnboardStatus()
      .then((data) => setOnboarded(data.onboarded))
      .catch(() => setOnboarded(false));
    fetchAuthStatus()
      .then((data) => setAuthEnabled(!!data.authEnabled))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!mobileSidebarOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [mobileSidebarOpen]);

  useEffect(() => {
    if (!onboarded) return;
    let active = true;
    const check = async (refresh = false) => {
      try {
        const data = await fetchAlphaclawVersion(refresh);
        if (!active) return;
        setAcVersion(data.currentVersion || null);
        setAcLatest(data.latestVersion || null);
        setAcHasUpdate(!!data.hasUpdate);
      } catch {}
    };
    check(true);
    const id = setInterval(() => check(false), 5 * 60 * 1000);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, [onboarded]);

  const refreshRestartStatus = useCallback(async () => {
    if (!onboarded) return;
    try {
      const data = await fetchRestartStatus();
      setRestartRequired(!!data.restartRequired);
      setRestartingGateway(!!data.restartInProgress);
    } catch {}
  }, [onboarded]);

  useEffect(() => {
    if (!onboarded) return;
    refreshRestartStatus();
  }, [onboarded, refreshRestartStatus]);

  useEffect(() => {
    if (!onboarded || (!restartRequired && !restartingGateway)) return;
    const id = setInterval(refreshRestartStatus, 2000);
    return () => clearInterval(id);
  }, [onboarded, restartRequired, restartingGateway, refreshRestartStatus]);

  const handleGatewayRestart = useCallback(async () => {
    if (restartingGateway) return;
    setRestartingGateway(true);
    try {
      const data = await restartGateway();
      if (!data?.ok) throw new Error(data?.error || "Gateway restart failed");
      setRestartRequired(!!data.restartRequired);
      showToast("Gateway restarted", "success");
      setTimeout(refreshRestartStatus, 800);
    } catch (err) {
      showToast(err.message || "Restart failed", "error");
      setTimeout(refreshRestartStatus, 800);
    } finally {
      setRestartingGateway(false);
    }
  }, [restartingGateway, refreshRestartStatus]);

  const handleAcUpdate = async () => {
    if (acUpdating) return;
    setAcUpdating(true);
    try {
      const data = await updateAlphaclaw();
      if (data.ok) {
        showToast("AlphaClaw updated — restarting...", "success");
        setTimeout(() => window.location.reload(), 5000);
      } else {
        showToast(data.error || "AlphaClaw update failed", "error");
        setAcUpdating(false);
      }
    } catch (err) {
      showToast(err.message || "Could not update AlphaClaw", "error");
      setAcUpdating(false);
    }
  };
  // Still loading onboard status
  if (onboarded === null) {
    return html`
      <div
        class="min-h-screen flex items-center justify-center"
        style="position: relative; z-index: 1"
      >
        <svg
          class="animate-spin h-6 w-6"
          style="color: var(--text-muted)"
          viewBox="0 0 24 24"
          fill="none"
        >
          <circle
            class="opacity-25"
            cx="12"
            cy="12"
            r="10"
            stroke="currentColor"
            stroke-width="4"
          />
          <path
            class="opacity-75"
            fill="currentColor"
            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
          />
        </svg>
      </div>
      <${ToastContainer} />
    `;
  }

  if (!onboarded) {
    return html`
      <div
        class="min-h-screen flex justify-center pt-12 pb-8 px-4"
        style="position: relative; z-index: 1"
      >
        <${Welcome} onComplete=${() => setOnboarded(true)} />
      </div>
      <${ToastContainer} />
    `;
  }

  const navigateToSubScreen = (screen) => {
    setLocation(`/${screen}`);
    setMobileSidebarOpen(false);
  };
  const exitSubScreen = () => {
    setLocation(`/${kDefaultUiTab}`);
    setMobileSidebarOpen(false);
  };
  const handleAppContentScroll = (e) => {
    const nextScrolled = e.currentTarget.scrollTop > 0;
    setMobileTopbarScrolled((currentScrolled) =>
      currentScrolled === nextScrolled ? currentScrolled : nextScrolled,
    );
  };

  const kNavItems = [
    { id: "general", label: "General" },
    { id: "providers", label: "Providers" },
    { id: "envars", label: "Envars" },
    { id: "webhooks", label: "Webhooks" },
  ];

  const selectedNavId =
    location === "/telegram"
      ? ""
      : location.startsWith("/providers")
      ? "providers"
      : location.startsWith("/envars")
      ? "envars"
      : location.startsWith("/webhooks")
      ? "webhooks"
      : "general";

  const renderWebhooks = (hookName = "") => html`
    <div class="pt-4">
      <${Webhooks}
        selectedHookName=${hookName}
        onSelectHook=${(name) => setLocation(`/webhooks/${encodeURIComponent(name)}`)}
        onBackToList=${() => setLocation("/webhooks")}
        onRestartRequired=${setRestartRequired}
      />
    </div>
  `;

  return html`
    <div class="app-shell">
      <${GlobalRestartBanner}
        visible=${restartRequired}
        restarting=${restartingGateway}
        onRestart=${handleGatewayRestart}
      />
      <div class=${`app-sidebar ${mobileSidebarOpen ? "mobile-open" : ""}`}>
        <div class="sidebar-brand">
          <img src="./img/logo.svg" alt="" width="20" height="20" />
          <span><span style="color: var(--accent)">alpha</span>claw</span>
          ${authEnabled && html`
            <div class="brand-menu" ref=${menuRef}>
              <button
                class="brand-menu-trigger"
                onclick=${() => setMenuOpen((o) => !o)}
                aria-label="Menu"
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                  <circle cx="8" cy="3" r="1.5" />
                  <circle cx="8" cy="8" r="1.5" />
                  <circle cx="8" cy="13" r="1.5" />
                </svg>
              </button>
              ${menuOpen && html`
                <div class="brand-dropdown">
                  <a
                    href="#"
                    onclick=${async (e) => {
                      e.preventDefault();
                      setMenuOpen(false);
                      await logout();
                      window.location.href = "/login.html";
                    }}
                  >Log out</a>
                </div>
              `}
            </div>
          `}
        </div>
        <div class="sidebar-label">Setup</div>
        <nav class="sidebar-nav">
          ${kNavItems.map(
            (item) => html`
              <a
                class=${selectedNavId === item.id ? "active" : ""}
                onclick=${() => {
                  setLocation(`/${item.id}`);
                  setMobileSidebarOpen(false);
                }}
              >
                ${item.label}
              </a>
            `,
          )}
        </nav>
        <div class="sidebar-footer">
          ${acHasUpdate && acLatest && !acDismissed
            ? html`
                <${UpdateActionButton}
                  onClick=${handleAcUpdate}
                  loading=${acUpdating}
                  warning=${true}
                  idleLabel=${`Update to v${acLatest}`}
                  loadingLabel="Updating..."
                  className="w-full justify-center"
                />
              `
            : null}
        </div>
      </div>

      <div
        class=${`mobile-sidebar-overlay ${mobileSidebarOpen ? "active" : ""}`}
        onclick=${() => setMobileSidebarOpen(false)}
      />

      <div class="app-content" onscroll=${handleAppContentScroll}>
        <div class=${`mobile-topbar ${mobileTopbarScrolled ? "is-scrolled" : ""}`}>
          <button
            class="mobile-topbar-menu"
            onclick=${() => setMobileSidebarOpen((open) => !open)}
            aria-label="Open menu"
            aria-expanded=${mobileSidebarOpen ? "true" : "false"}
          >
            <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor">
              <path
                d="M2 3.75a.75.75 0 01.75-.75h10.5a.75.75 0 010 1.5H2.75A.75.75 0 012 3.75zm0 4.25a.75.75 0 01.75-.75h10.5a.75.75 0 010 1.5H2.75A.75.75 0 012 8zm0 4.25a.75.75 0 01.75-.75h10.5a.75.75 0 010 1.5H2.75a.75.75 0 01-.75-.75z"
              />
            </svg>
          </button>
          <span class="mobile-topbar-title">
            <span style="color: var(--accent)">alpha</span>claw
          </span>
        </div>
        <div class="max-w-2xl w-full mx-auto">
          <${Switch}>
            <${Route} path="/telegram">
              <div class="pt-4">
                <${TelegramWorkspace} onBack=${exitSubScreen} />
              </div>
            </${Route}>
            <${Route} path="/general">
              <div class="pt-4">
                <${GeneralTab}
                  onSwitchTab=${(nextTab) => setLocation(`/${nextTab}`)}
                  onNavigate=${navigateToSubScreen}
                  isActive=${location === "/general"}
                  restartingGateway=${restartingGateway}
                  onRestartGateway=${handleGatewayRestart}
                />
              </div>
            </${Route}>
            <${Route} path="/providers">
              <div class="pt-4">
                <${Providers} onRestartRequired=${setRestartRequired} />
              </div>
            </${Route}>
            <${Route} path="/envars">
              <div class="pt-4">
                <${Envars} onRestartRequired=${setRestartRequired} />
              </div>
            </${Route}>
            <${Route} path="/webhooks/:hookName">
              ${(params) => renderWebhooks(decodeURIComponent(params.hookName || ""))}
            </${Route}>
            <${Route} path="/webhooks">
              ${() => renderWebhooks("")}
            </${Route}>
            <${Route}>
              <${RouteRedirect} to="/general" />
            </${Route}>
          </${Switch}>
        </div>
      </div>

      <div class="app-statusbar">
        <div class="statusbar-left">
          ${acVersion
            ? html`<span style="color: var(--text-muted)">v${acVersion}</span>`
            : null}
        </div>
        <div class="statusbar-right">
          <a href="https://docs.openclaw.ai" target="_blank" rel="noreferrer"
            >docs</a
          >
          <a
            href="https://discord.com/invite/clawd"
            target="_blank"
            rel="noreferrer"
            >discord</a
          >
          <a
            href="https://github.com/openclaw/openclaw"
            target="_blank"
            rel="noreferrer"
            >github</a
          >
        </div>
      </div>
    </div>
    <${ToastContainer} />
  `;
};

render(
  html`
    <${Router} hook=${useHashLocation}>
      <${App} />
    </${Router}>
  `,
  document.getElementById("app"),
);
