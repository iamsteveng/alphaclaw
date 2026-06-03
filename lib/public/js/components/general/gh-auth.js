import { h } from "preact";
import { useState, useEffect, useRef, useCallback } from "preact/hooks";
import htm from "htm";
import { authFetch } from "../../lib/api.js";
import { showToast } from "../toast.js";
import { ActionButton } from "../action-button.js";

const html = htm.bind(h);

const GithubIcon = () => html`
  <svg class="w-4 h-4 shrink-0" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
    <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
  </svg>
`;

export const GhAuth = () => {
  const [phase, setPhase] = useState("loading");
  // loading | unauthenticated | device_code | authenticated | error
  const [user, setUser] = useState(null);
  const [deviceData, setDeviceData] = useState(null);
  const [errorMsg, setErrorMsg] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const pollTimer = useRef(null);
  const cancelled = useRef(false);
  const expiresAt = useRef(0);

  const stopPolling = () => {
    if (pollTimer.current) {
      clearTimeout(pollTimer.current);
      pollTimer.current = null;
    }
  };

  const loadStatus = useCallback(async () => {
    try {
      const res = await authFetch("/api/gh/auth/status");
      const data = await res.json();
      if (data.authenticated) {
        setUser(data.user);
        setPhase("authenticated");
      } else {
        setPhase("unauthenticated");
      }
    } catch {
      setPhase("unauthenticated");
    }
  }, []);

  useEffect(() => {
    loadStatus();
    return stopPolling;
  }, []);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const pollForToken = useCallback(async (device_code, interval) => {
    // Guard: user clicked Cancel or component unmounted
    if (cancelled.current) return;
    // Guard: device code expired client-side
    if (expiresAt.current && Date.now() > expiresAt.current) {
      setErrorMsg("Device code expired. Please try again.");
      setPhase("error");
      return;
    }

    try {
      const res = await authFetch("/api/gh/auth/device/poll", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ device_code }),
      });
      // Re-check cancellation after the async fetch returns
      if (cancelled.current) return;

      const data = await res.json();
      if (cancelled.current) return;

      if (!data.ok || data.status === "error") {
        stopPolling();
        setErrorMsg(data.error || "Authentication error");
        setPhase("error");
        return;
      }
      if (data.status === "success") {
        stopPolling();
        setUser(data.user);
        setDeviceData(null);
        setPhase("authenticated");
        showToast("GitHub CLI connected", "success");
        return;
      }
      if (data.status === "expired") {
        stopPolling();
        setErrorMsg("Device code expired. Please try again.");
        setPhase("error");
        return;
      }
      if (data.status === "denied") {
        stopPolling();
        setErrorMsg("Authorization was denied.");
        setPhase("error");
        return;
      }

      const next = data.status === "slow_down" ? (data.interval || interval + 5) : interval;
      pollTimer.current = setTimeout(() => pollForToken(device_code, next), next * 1000);
    } catch {
      if (cancelled.current) return;
      pollTimer.current = setTimeout(() => pollForToken(device_code, interval), interval * 1000);
    }
  }, []);

  const handleConnect = async () => {
    cancelled.current = false;
    setConnecting(true);
    setErrorMsg("");
    try {
      const res = await authFetch("/api/gh/auth/device/start", { method: "POST" });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Failed to start auth");
      expiresAt.current = data.expires_in ? Date.now() + data.expires_in * 1000 : 0;
      setDeviceData(data);
      setPhase("device_code");
      const interval = data.interval || 5;
      pollTimer.current = setTimeout(() => pollForToken(data.device_code, interval), interval * 1000);
    } catch (err) {
      setErrorMsg(err.message || "Failed to start GitHub auth");
      setPhase("error");
    } finally {
      setConnecting(false);
    }
  };

  const handleDisconnect = async () => {
    setDisconnecting(true);
    try {
      await authFetch("/api/gh/auth/logout", { method: "POST" });
      stopPolling();
      setUser(null);
      setDeviceData(null);
      setPhase("unauthenticated");
    } catch {
      showToast("Disconnect failed", "error");
    } finally {
      setDisconnecting(false);
    }
  };

  const handleRetry = () => {
    cancelled.current = true;
    stopPolling();
    setConnecting(false);
    setErrorMsg("");
    setDeviceData(null);
    setPhase("unauthenticated");
  };

  const copyCode = () => {
    if (deviceData?.user_code) {
      navigator.clipboard?.writeText(deviceData.user_code).catch(() => {});
    }
  };

  return html`
    <div class="bg-surface border border-border rounded-xl p-4">
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-2">
          <${GithubIcon} />
          <h2 class="font-semibold text-sm">GitHub CLI</h2>
          ${phase === "authenticated" &&
            html`<span
              class="text-xs text-status-success bg-status-success-bg border border-status-success-border px-1.5 py-0.5 rounded-full"
              >Connected</span
            >`}
        </div>
        ${phase === "authenticated" &&
          html`<${ActionButton}
            onClick=${handleDisconnect}
            loading=${disconnecting}
            tone="danger"
            size="sm"
            idleLabel="Disconnect"
            loadingLabel="Disconnecting..."
          />`}
        ${phase === "unauthenticated" &&
          html`<${ActionButton}
            onClick=${handleConnect}
            loading=${connecting}
            tone="primary"
            size="sm"
            idleLabel="Connect"
            loadingLabel="Starting..."
          />`}
      </div>

      ${phase === "loading" &&
        html`<p class="mt-2 text-xs text-fg-muted">Checking status…</p>`}

      ${phase === "authenticated" && user &&
        html`<p class="mt-1.5 text-xs text-fg-muted">@${user}</p>`}

      ${phase === "device_code" && deviceData &&
        html`
          <div class="mt-3 space-y-3">
            <p class="text-xs text-fg-muted">
              Copy the code, then authorize at GitHub.
            </p>
            <div class="flex items-center gap-2">
              <span
                class="font-mono text-base font-bold tracking-widest text-body bg-field border border-border rounded-lg px-3 py-1.5"
              >
                ${deviceData.user_code}
              </span>
              <button
                class="text-xs text-primary hover:underline"
                onClick=${copyCode}
              >
                Copy
              </button>
            </div>
            <a
              href="${deviceData.verification_uri}"
              target="_blank"
              rel="noopener noreferrer"
              class="inline-flex items-center gap-1 text-xs text-primary hover:underline"
            >
              Open github.com/login/device
              <svg
                class="w-3 h-3"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
              >
                <path
                  d="M6 3H3a1 1 0 00-1 1v9a1 1 0 001 1h9a1 1 0 001-1v-3M9 2h5m0 0v5m0-5L7 10"
                />
              </svg>
            </a>
            <p class="text-xs text-fg-muted flex items-center gap-1.5">
              <span
                class="inline-block w-1.5 h-1.5 rounded-full bg-status-success animate-pulse"
              ></span>
              Waiting for authorization…
            </p>
            <button
              class="text-xs text-fg-dim hover:text-body underline"
              onClick=${handleRetry}
            >
              Cancel
            </button>
          </div>
        `}

      ${phase === "error" &&
        html`
          <div class="mt-3 space-y-2">
            <p class="text-xs text-status-error">${errorMsg}</p>
            <button
              class="text-xs text-primary hover:underline"
              onClick=${handleRetry}
            >
              Try again
            </button>
          </div>
        `}
    </div>
  `;
};
