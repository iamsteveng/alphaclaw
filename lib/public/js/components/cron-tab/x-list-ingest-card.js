import { h } from "preact";
import { useState, useEffect, useCallback } from "preact/hooks";
import htm from "htm";
import { ActionButton } from "../action-button.js";
import { showToast } from "../toast.js";
import { fetchXListIngestStatus, ensureXListIngest, removeXListIngest } from "../../lib/api.js";

const html = htm.bind(h);

const XIcon = () => html`
  <svg class="w-4 h-4 shrink-0 fill-current" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.746l7.73-8.835L1.254 2.25H8.08l4.26 5.632 5.9-5.632zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
  </svg>
`;

export const XListIngestCard = () => {
  const [status, setStatus] = useState(null);
  const [registering, setRegistering] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [updating, setUpdating] = useState(false);

  const loadStatus = useCallback(async () => {
    try {
      const s = await fetchXListIngestStatus();
      setStatus(s);
    } catch {
      setStatus({ envVarSet: false, listId: null, job: null });
    }
  }, []);

  useEffect(() => { loadStatus(); }, [loadStatus]);

  const handleRegister = async () => {
    setRegistering(true);
    try {
      const r = await ensureXListIngest();
      if (!r.ok) throw new Error(r.error || "Registration failed");
      showToast("X list ingest cron registered", "success");
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
      const r = await removeXListIngest();
      if (!r.ok) throw new Error(r.error || "De-registration failed");
      showToast("X list ingest cron removed", "success");
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
      await removeXListIngest();
      const r = await ensureXListIngest();
      if (!r.ok) throw new Error(r.error || "Update failed");
      showToast("X list ingest cron updated", "success");
      await loadStatus();
    } catch (err) {
      showToast(err.message, "error");
    } finally {
      setUpdating(false);
    }
  };

  const isRegistered = !!status?.job;
  const envVarSet = !!status?.envVarSet;
  const busy = registering || removing || updating;

  return html`
    <div class="bg-surface border border-border rounded-xl overflow-hidden">
      <div class="flex items-center gap-2.5 px-4 py-3 border-b border-border">
        <${XIcon} />
        <div class="flex-1 min-w-0">
          <p class="text-sm font-medium text-body">X List → gbrain Ingest</p>
          <p class="text-xs text-fg-muted">Hourly · 10 posts · gbrain knowledge graph</p>
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
        <div class=${`flex items-start gap-2 rounded-lg border px-3 py-2 text-xs ${envVarSet ? "border-status-success-border bg-status-success-muted text-status-success" : "border-status-warning-border bg-status-warning-bg text-status-warning"}`}>
          <span class="font-mono font-medium shrink-0 mt-0.5">${envVarSet ? "✓" : "✗"}</span>
          <div>
            <span class="font-mono font-medium">X_INGEST_LIST_ID</span>
            ${envVarSet
              ? html`<span class="ml-1 opacity-75">${status.listId}</span>`
              : html`<span class="ml-1 opacity-90"> — not set. Add to Railway service env vars and redeploy.</span>`}
          </div>
        </div>

        ${isRegistered
          ? html`
              <div class="space-y-2">
                <div class="text-xs text-fg-muted space-y-0.5">
                  <div>Schedule: <span class="font-mono text-body">${status.job?.cron || "0 * * * *"}</span> UTC</div>
                  <div>Status: <span class=${`font-medium ${status.job?.enabled ? "text-status-success" : "text-fg-muted"}`}>${status.job?.enabled ? "Enabled" : "Disabled"}</span></div>
                </div>
                <div class="flex gap-2 pt-1">
                  <${ActionButton}
                    idleLabel="Update"
                    loadingLabel="Updating…"
                    loading=${updating}
                    onClick=${handleUpdate}
                    disabled=${busy || !envVarSet}
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
                  Registers an hourly cron job on the openclaw main agent. Requires
                  <span class="font-mono">X_INGEST_LIST_ID</span> set in Railway env vars.
                </p>
                <${ActionButton}
                  idleLabel="Register"
                  loadingLabel="Registering…"
                  loading=${registering}
                  onClick=${handleRegister}
                  disabled=${busy || !envVarSet}
                  tone="primary"
                  size="sm"
                />
              </div>
            `}
      </div>
    </div>
  `;
};
