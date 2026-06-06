import { h } from "preact";
import { useState, useEffect, useCallback } from "preact/hooks";
import htm from "htm";
import { ActionButton } from "../action-button.js";
import { SecretInput } from "../secret-input.js";
import { showToast } from "../toast.js";
import { fetchTradingCronsStatus, ensureTradingCrons, removeTradingCrons, saveEnvVars } from "../../lib/api.js";
import { useDestinationSessionSelection, kNoDestinationSessionValue } from "../../hooks/use-destination-session-selection.js";
import { getSessionDisplayLabel, getSessionRowKey } from "../../lib/session-keys.js";

const html = htm.bind(h);

const kJobLabels = {
  "trading-watchlist-builder":    { label: "Watchlist builder",   schedule: "8:00 AM ET · weekdays" },
  "trading-market-risk-score":    { label: "Market risk score",   schedule: "9:35 AM ET · weekdays" },
  "trading-price-report":         { label: "Price report",        schedule: "Every 15 min, 9:30–12:30 PM ET · weekdays" },
  "trading-eod-loop":             { label: "EOD learning loop",   schedule: "4:30 PM ET · weekdays" },
};

const TrendingIcon = () => html`
  <svg class="w-4 h-4 shrink-0 fill-none stroke-current" viewBox="0 0 24 24" stroke-width="1.75" aria-hidden="true">
    <polyline points="23 6 13.5 15.5 8.5 10.5 1 18" stroke-linecap="round" stroke-linejoin="round" />
    <polyline points="17 6 23 6 23 12" stroke-linecap="round" stroke-linejoin="round" />
  </svg>
`;

export const TradingAdvisorCard = () => {
  const [status, setStatus] = useState(null);
  const [registering, setRegistering] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [finnhubKey, setFinnhubKey] = useState("");
  const [savingKey, setSavingKey] = useState(false);
  const [showKeyInput, setShowKeyInput] = useState(false);

  const {
    sessions,
    loading: loadingSessions,
    error: sessionsError,
    destinationSessionKey,
    setDestinationSessionKey,
    selectedDestination,
  } = useDestinationSessionSelection({ enabled: true });

  const loadStatus = useCallback(async () => {
    try {
      const s = await fetchTradingCronsStatus();
      setStatus(s);
    } catch {
      setStatus({ jobs: [], finnhubConfigured: false });
    }
  }, []);

  useEffect(() => { loadStatus(); }, [loadStatus]);

  const getDeliveryParams = () => ({
    deliveryChannel: selectedDestination?.channel || "",
    deliveryTo: selectedDestination?.to || "",
  });

  const handleSaveKey = async () => {
    if (!finnhubKey.trim()) return;
    setSavingKey(true);
    try {
      await saveEnvVars([{ key: "FINNHUB_API_KEY", value: finnhubKey.trim() }]);
      showToast("Finnhub API key saved", "success");
      setFinnhubKey("");
      setShowKeyInput(false);
      await loadStatus();
    } catch (err) {
      showToast(err.message || "Failed to save key", "error");
    } finally {
      setSavingKey(false);
    }
  };

  const handleRegister = async () => {
    setRegistering(true);
    try {
      const r = await ensureTradingCrons(getDeliveryParams());
      if (!r.ok) throw new Error(r.error || "Registration failed");
      showToast("Trading advisor crons registered", "success");
      await loadStatus();
    } catch (err) {
      showToast(err.message, "error");
    } finally {
      setRegistering(false);
    }
  };

  const handleRemove = async () => {
    setRemoving(true);
    try {
      const r = await removeTradingCrons();
      if (!r.ok) throw new Error(r.error || "De-registration failed");
      showToast("Trading advisor crons removed", "success");
      await loadStatus();
    } catch (err) {
      showToast(err.message, "error");
    } finally {
      setRemoving(false);
    }
  };

  const handleUpdate = async () => {
    setUpdating(true);
    try {
      await removeTradingCrons();
      const r = await ensureTradingCrons(getDeliveryParams());
      if (!r.ok) throw new Error(r.error || "Update failed");
      showToast("Trading advisor crons updated", "success");
      await loadStatus();
    } catch (err) {
      showToast(err.message, "error");
    } finally {
      setUpdating(false);
    }
  };

  const registeredJobs = (status?.jobs || []).filter((j) => !!j.job);
  const isRegistered = registeredJobs.length > 0;
  const finnhubConfigured = !!status?.finnhubConfigured;
  const busy = registering || removing || updating;

  const finnhubSection = html`
    <div class="space-y-1">
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-1.5 text-xs">
          <span class=${`w-1.5 h-1.5 rounded-full shrink-0 ${finnhubConfigured ? "bg-status-success" : "bg-status-warning"}`}></span>
          <span class="text-fg-muted">
            Finnhub price feed:${" "}
            <span class=${finnhubConfigured ? "text-status-success" : "text-status-warning"}>
              ${finnhubConfigured ? "configured" : "not configured"}
            </span>
          </span>
        </div>
        <button
          type="button"
          class="text-xs text-fg-muted hover:text-body underline underline-offset-2"
          onClick=${() => { setShowKeyInput((v) => !v); setFinnhubKey(""); }}
        >
          ${finnhubConfigured ? (showKeyInput ? "Cancel" : "Change") : (showKeyInput ? "Cancel" : "Set key")}
        </button>
      </div>
      ${(!finnhubConfigured || showKeyInput)
        ? html`
            <div class="flex gap-2 items-center">
              <div class="flex-1 bg-field border border-border rounded-lg px-2 py-1.5 text-[11px]">
                <${SecretInput}
                  value=${finnhubKey}
                  onInput=${(e) => setFinnhubKey(e.currentTarget.value)}
                  placeholder="Paste Finnhub API key…"
                  disabled=${savingKey}
                  inputClass="w-full bg-transparent text-[11px] text-body outline-none"
                />
              </div>
              <button
                type="button"
                class="text-xs px-2.5 py-1.5 rounded-lg bg-primary text-white font-medium disabled:opacity-50"
                disabled=${savingKey || !finnhubKey.trim()}
                onClick=${handleSaveKey}
              >
                ${savingKey ? "Saving…" : "Save"}
              </button>
            </div>
          `
        : null}
    </div>
  `;

  const deliveryDropdown = html`
    <div>
      <label class="block text-xs text-fg-muted mb-1">Deliver results to</label>
      <select
        value=${destinationSessionKey || kNoDestinationSessionValue}
        onInput=${(e) => setDestinationSessionKey(e.currentTarget.value)}
        disabled=${busy}
        class="w-full bg-field border border-border rounded-lg px-2 py-1.5 text-[11px] text-body focus:border-fg-muted"
      >
        <option value=${kNoDestinationSessionValue}>None</option>
        ${sessions.map((sessionRow) => html`
          <option value=${getSessionRowKey(sessionRow)}>
            ${getSessionDisplayLabel(sessionRow) || getSessionRowKey(sessionRow)}
          </option>
        `)}
      </select>
      ${loadingSessions ? html`<div class="text-[11px] text-fg-muted pt-1">Loading channels…</div>` : null}
      ${sessionsError ? html`<div class="text-[11px] text-status-error pt-1">${sessionsError}</div>` : null}
    </div>
  `;

  return html`
    <div class="bg-surface border border-border rounded-xl overflow-hidden">
      <div class="flex items-center gap-2.5 px-4 py-3 border-b border-border">
        <${TrendingIcon} />
        <div class="flex-1 min-w-0">
          <p class="text-sm font-medium text-body">Trading Advisor</p>
          <p class="text-xs text-fg-muted">Watchlist · Risk score · Price report · EOD loop</p>
        </div>
        ${isRegistered
          ? html`<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-status-success-muted text-status-success">
              <span class="w-1.5 h-1.5 rounded-full bg-status-success"></span>Registered
            </span>`
          : html`<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-surface-raised text-fg-muted border border-border">
              Not registered
            </span>`}
      </div>

      <div class="p-4 space-y-3">
        ${isRegistered
          ? html`
              <div class="space-y-2">
                <div class="space-y-1">
                  ${(status?.jobs || []).map(({ name, job }) => {
                    const meta = kJobLabels[name] || { label: name, schedule: "" };
                    return html`
                      <div class="flex items-center justify-between text-xs">
                        <span class="text-body">${meta.label}</span>
                        <span class="text-fg-muted font-mono">${meta.schedule}</span>
                        <span class=${`font-medium ml-2 ${job?.enabled ? "text-status-success" : "text-fg-muted"}`}>
                          ${job ? (job.enabled ? "On" : "Off") : "—"}
                        </span>
                      </div>
                    `;
                  })}
                </div>
                ${finnhubSection}
                ${deliveryDropdown}
                <div class="flex gap-2 pt-1">
                  <${ActionButton}
                    idleLabel="Update"
                    loadingLabel="Updating…"
                    loading=${updating}
                    onClick=${handleUpdate}
                    disabled=${busy}
                    tone="secondary"
                    size="sm"
                  />
                  <${ActionButton}
                    idleLabel="De-register"
                    loadingLabel="Removing…"
                    loading=${removing}
                    onClick=${handleRemove}
                    disabled=${busy}
                    tone="danger"
                    size="sm"
                  />
                </div>
              </div>
            `
          : html`
              <div class="space-y-2.5">
                <p class="text-xs text-fg-muted">
                  Registers 4 cron jobs (all ET, weekdays): watchlist builder (8 AM), market risk score (9:35 AM), price reports every 15 min during the first 3 hours of trading, and an EOD learning loop (4:30 PM). Schedules are DST-aware.
                </p>
                ${finnhubSection}
                ${deliveryDropdown}
                <${ActionButton}
                  idleLabel="Register"
                  loadingLabel="Registering…"
                  loading=${registering}
                  onClick=${handleRegister}
                  disabled=${busy}
                  tone="primary"
                  size="sm"
                />
              </div>
            `}
      </div>
    </div>
  `;
};
