import { h } from "preact";
import { useState, useEffect, useCallback } from "preact/hooks";
import htm from "htm";
import { SecretInput } from "../secret-input.js";
import { ActionButton } from "../action-button.js";
import { showToast } from "../toast.js";

const html = htm.bind(h);

const apiFetch = (url, opts = {}) =>
  fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  }).then((r) => r.json());

const XIcon = () => html`
  <svg class="w-4 h-4 shrink-0 fill-current" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.746l7.73-8.835L1.254 2.25H8.08l4.26 5.632 5.9-5.632zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
  </svg>
`;

const FIELDS = [
  { key: "authToken", label: "auth_token", placeholder: "auth_token cookie", required: true },
  { key: "ct0",       label: "ct0",        placeholder: "ct0 cookie", required: true },
  { key: "twid",      label: "twid",       placeholder: 'twid cookie (e.g. u=1234567890)', required: true },
  { key: "kdt",       label: "kdt (optional)", placeholder: "kdt cookie — improves longevity", required: false },
];

const emptyForm = () => ({ authToken: "", ct0: "", twid: "", kdt: "" });

export const XWebSessionCard = () => {
  const [status, setStatus] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [removing, setRemoving] = useState(false);

  const loadStatus = useCallback(async () => {
    try {
      setStatus(await apiFetch("/api/x/web-session/status"));
    } catch {
      setStatus({ configured: false });
    }
  }, []);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  const handleSave = async () => {
    if (!form.authToken || !form.ct0 || !form.twid) {
      showToast("auth_token, ct0 and twid are required", "error");
      return;
    }
    setSaving(true);
    try {
      const r = await apiFetch("/api/x/web-session", {
        method: "POST",
        body: JSON.stringify(form),
      });
      if (!r.ok) throw new Error(r.error || "Failed to save session");
      setForm(emptyForm());
      showToast(`Connected as @${r.username}`, "success");
      await loadStatus();
    } catch (err) {
      showToast(err.message, "error");
    } finally {
      setSaving(false);
    }
  };

  const handleVerify = async () => {
    setVerifying(true);
    try {
      const r = await apiFetch("/api/x/web-session/verify", { method: "POST" });
      if (!r.ok) throw new Error(r.error || "Verification failed");
      showToast(`Session live: @${r.username}`, "success");
    } catch (err) {
      showToast(err.message, "error");
    } finally {
      setVerifying(false);
    }
  };

  const handleRemove = async () => {
    setRemoving(true);
    try {
      await apiFetch("/api/x/web-session", { method: "DELETE" });
      showToast("X session disconnected", "success");
      await loadStatus();
    } catch (err) {
      showToast(err.message, "error");
    } finally {
      setRemoving(false);
    }
  };

  const isConfigured = status?.configured;
  const busy = saving || verifying || removing;

  return html`
    <div class="bg-surface border border-border rounded-xl overflow-hidden">
      <div class="flex items-center gap-2.5 px-4 py-3 border-b border-border">
        <${XIcon} />
        <div class="flex-1 min-w-0">
          <p class="text-sm font-medium text-body">X Free Crawl (cookie session)</p>
          <p class="text-xs text-fg-muted">Reads lists without the paid API · use a burner account</p>
        </div>
        ${isConfigured
          ? html`
              <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-status-success-muted text-status-success">
                <span class="w-1.5 h-1.5 rounded-full bg-status-success"></span>
                Connected
              </span>
            `
          : null}
      </div>

      <div class="p-4 space-y-3">
        ${isConfigured
          ? html`
              <div class="space-y-2">
                <div class="flex items-center gap-2 text-sm text-body">
                  ${status.username
                    ? html`<span class="font-medium">@${status.username}</span>`
                    : null}
                </div>
                <p class="text-xs text-fg-muted">
                  Sessions expire when the account logs out or changes password.
                  Use Test to check the cookies are still live.
                </p>
                <div class="flex gap-2 pt-1">
                  <${ActionButton}
                    idleLabel="Test"
                    loadingLabel="Testing…"
                    loading=${verifying}
                    onClick=${handleVerify}
                    disabled=${busy}
                    tone="secondary"
                    size="sm"
                  />
                  <${ActionButton}
                    idleLabel="Remove"
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
                  Log into a <span class="font-medium">burner</span> X account in a
                  browser, open DevTools → Application → Cookies → https://x.com, and
                  copy these cookie values. This uses X's internal endpoints
                  (against its Terms) — keep it off your main account.
                </p>
                ${FIELDS.map(
                  ({ key, label, placeholder }) => html`
                    <div key=${key}>
                      <label class="block text-xs font-medium text-fg-muted mb-1">${label}</label>
                      <${SecretInput}
                        value=${form[key]}
                        onInput=${(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
                        placeholder=${placeholder}
                        disabled=${saving}
                      />
                    </div>
                  `,
                )}
                <div class="pt-1">
                  <${ActionButton}
                    idleLabel="Save & Verify"
                    loadingLabel="Verifying…"
                    loading=${saving}
                    onClick=${handleSave}
                    disabled=${saving}
                    tone="primary"
                    size="sm"
                  />
                </div>
              </div>
            `}
      </div>
    </div>
  `;
};
