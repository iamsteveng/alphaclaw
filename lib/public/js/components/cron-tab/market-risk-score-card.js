import { h } from "preact";
import { useState, useEffect, useCallback } from "preact/hooks";
import htm from "htm";
import { ActionButton } from "../action-button.js";
import { showToast } from "../toast.js";
import { fetchMarketRiskScoreStatus, ensureMarketRiskScore, removeMarketRiskScore } from "../../lib/api.js";
import { useDestinationSessionSelection, kNoDestinationSessionValue } from "../../hooks/use-destination-session-selection.js";
import { getDestinationFromSession, getSessionDisplayLabel, getSessionRowKey } from "../../lib/session-keys.js";

const html = htm.bind(h);

const ChartIcon = () => html`
  <svg class="w-4 h-4 shrink-0 fill-none stroke-current" viewBox="0 0 24 24" stroke-width="1.75" aria-hidden="true">
    <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" stroke-linecap="round" stroke-linejoin="round" />
  </svg>
`;

export const MarketRiskScoreCard = () => {
  const [status, setStatus] = useState(null);
  const [registering, setRegistering] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [updating, setUpdating] = useState(false);

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
      const s = await fetchMarketRiskScoreStatus();
      setStatus(s);
    } catch {
      setStatus({ job: null });
    }
  }, []);

  useEffect(() => { loadStatus(); }, [loadStatus]);

  const getDeliveryParams = () => ({
    deliveryChannel: selectedDestination?.channel || "",
    deliveryTo: selectedDestination?.to || "",
  });

  const handleRegister = async () => {
    setRegistering(true);
    try {
      const r = await ensureMarketRiskScore(getDeliveryParams());
      if (!r.ok) throw new Error(r.error || "Registration failed");
      showToast("Market risk score cron registered", "success");
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
      const r = await removeMarketRiskScore();
      if (!r.ok) throw new Error(r.error || "De-registration failed");
      showToast("Market risk score cron removed", "success");
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
      await removeMarketRiskScore();
      const r = await ensureMarketRiskScore(getDeliveryParams());
      if (!r.ok) throw new Error(r.error || "Update failed");
      showToast("Market risk score cron updated", "success");
      await loadStatus();
    } catch (err) {
      showToast(err.message, "error");
    } finally {
      setUpdating(false);
    }
  };

  const isRegistered = !!status?.job;
  const busy = registering || removing || updating;

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
        <${ChartIcon} />
        <div class="flex-1 min-w-0">
          <p class="text-sm font-medium text-body">US Market Risk Score</p>
          <p class="text-xs text-fg-muted">Daily 9 PM HKT · Main agent</p>
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
                <div class="text-xs text-fg-muted space-y-0.5">
                  <div>Schedule: <span class="font-mono text-body">${status.job?.cron || "0 21 * * *"}</span> Asia/Hong_Kong</div>
                  <div>Status: <span class=${`font-medium ${status.job?.enabled ? "text-status-success" : "text-fg-muted"}`}>${status.job?.enabled ? "Enabled" : "Disabled"}</span></div>
                </div>
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
                  Registers a daily cron job that runs at 9 PM Hong Kong time and prompts the main agent for the US market risk score.
                </p>
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
