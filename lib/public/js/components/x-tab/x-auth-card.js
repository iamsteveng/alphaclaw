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
  <svg
    class="w-4 h-4 shrink-0 fill-current"
    viewBox="0 0 24 24"
    aria-hidden="true"
  >
    <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.746l7.73-8.835L1.254 2.25H8.08l4.26 5.632 5.9-5.632zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
  </svg>
`;

const FIELDS = [
  { key: "consumerKey",    label: "API Key",              placeholder: "API Key from Developer Portal" },
  { key: "consumerSecret", label: "API Key Secret",       placeholder: "API Key Secret" },
  { key: "accessToken",    label: "Access Token",         placeholder: "Access Token" },
  { key: "accessSecret",   label: "Access Token Secret",  placeholder: "Access Token Secret" },
];

const emptyForm = () => ({
  consumerKey: "",
  consumerSecret: "",
  accessToken: "",
  accessSecret: "",
});

export const XAuthCard = () => {
  const [status, setStatus] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [removing, setRemoving] = useState(false);

  const loadStatus = useCallback(async () => {
    try {
      const s = await apiFetch("/api/x/auth/status");
      setStatus(s);
    } catch {
      setStatus({ configured: false });
    }
  }, []);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  const handleSave = async () => {
    const { consumerKey, consumerSecret, accessToken, accessSecret } = form;
    if (!consumerKey || !consumerSecret || !accessToken || !accessSecret) {
      showToast("All four credential fields are required", "error");
      return;
    }
    setSaving(true);
    try {
      const r = await apiFetch("/api/x/auth", {
        method: "POST",
        body: JSON.stringify(form),
      });
      if (!r.ok) throw new Error(r.error || "Failed to save credentials");
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
      const r = await apiFetch("/api/x/auth/verify", { method: "POST" });
      if (!r.ok) throw new Error(r.error || "Verification failed");
      showToast(`Verified: @${r.username}`, "success");
    } catch (err) {
      showToast(err.message, "error");
    } finally {
      setVerifying(false);
    }
  };

  const handleRemove = async () => {
    setRemoving(true);
    try {
      await apiFetch("/api/x/auth", { method: "DELETE" });
      showToast("X account disconnected", "success");
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
          <p class="text-sm font-medium text-body">X (Twitter)</p>
          <p class="text-xs text-fg-muted">OAuth 1.0a · Read lists and posts</p>
        </div>
        ${isConfigured
          ? html`
              <span
                class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-status-success-muted text-status-success"
              >
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
                  <span class="text-fg-dim text-xs">${status.keyPreview}</span>
                </div>
                <p class="text-xs text-fg-muted">
                  Credentials never expire. Use Test to verify they are still
                  valid.
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
                  All four credentials are from the
                  <a
                    href="https://developer.x.com"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="underline hover:text-body"
                  >X Developer Portal</a>
                  → Your App → Keys and Tokens.
                </p>
                ${FIELDS.map(
                  ({ key, label, placeholder }) => html`
                    <div key=${key}>
                      <label class="block text-xs font-medium text-fg-muted mb-1">
                        ${label}
                      </label>
                      <${SecretInput}
                        value=${form[key]}
                        onInput=${(e) =>
                          setForm((f) => ({ ...f, [key]: e.target.value }))}
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
