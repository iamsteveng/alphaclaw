### Prioritized Implementation Order

1. **[P0 | S] Unify toast type mapping in one place so callers consistently use semantic levels.**
   - [x] Update `lib/public/js/components/toast.js` (`showToast`, `ToastContainer`) to normalize legacy values.
   - [x] Normalize highest-impact callers first: `lib/public/js/components/providers.js`, `lib/public/js/components/models.js`, `lib/public/js/components/google.js`, `lib/public/js/components/gateway.js`, `lib/public/js/components/envars.js`, `lib/public/js/components/webhooks.js`.
   - Current inconsistency snapshot:
     - Legacy color callers: `lib/public/js/components/providers.js`, `lib/public/js/components/models.js`, `lib/public/js/components/google.js`.
     - Semantic callers: `lib/public/js/components/envars.js`, `lib/public/js/components/webhooks.js`, `lib/public/js/components/gateway.js`, `lib/public/js/components/telegram-workspace.js`.

2. **[P0 | M] Add a shared restart banner component (and/or restart hook) for restart-required flows.**
   - [x] Extract shared banner + handler state from: `lib/public/js/components/envars.js`, `lib/public/js/components/providers.js`, `lib/public/js/components/webhooks.js`.
   - [x] Keep `restartGateway` integration aligned with existing gateway action UI in `lib/public/js/components/gateway.js`.
   - Current inconsistency snapshot:
     - Duplicate banner + state + handler logic in the same 3 files above.

3. **[P1 | S] Add a small shared loading spinner component to replace repeated inline SVG.**
   - [x] Replace inline spinners in: `lib/public/js/app.js`, `lib/public/js/components/providers.js`, `lib/public/js/components/models.js`, `lib/public/js/components/onboarding/welcome-setup-step.js`.
   - [x] Evaluate whether `lib/public/js/components/update-action-button.js` should consume the shared spinner as well.
   - Current inconsistency snapshot:
     - Spinner markup shape and sizing differ slightly by file.

4. **[P1 | M] Standardize button styles around `ac-btn-*` + common disabled treatment.**
   - [x] Convert ad-hoc utility button patterns in: `lib/public/js/components/pairings.js` (Reject), `lib/public/js/components/device-pairings.js` (Reject), `lib/public/js/components/webhooks.js` (Create/Delete), `lib/public/js/components/google.js` (disconnect action), `lib/public/js/components/providers.js` (Codex reconnect/disconnect/restart).
   - [x] Align onboarding variants in: `lib/public/js/components/onboarding/welcome-setup-step.js`, `lib/public/js/components/onboarding/welcome-form-step.js`, `lib/public/js/components/onboarding/welcome-pairing-step.js`.
   - Current inconsistency snapshot:
     - Mixed custom classes vs ad-hoc border utility buttons.

5. **[P1 | S] Normalize disabled opacity usage to one convention.**
   - [x] Standardize `opacity-50` vs `opacity-60` in:
     - `lib/public/js/components/envars.js`
     - `lib/public/js/components/providers.js`
     - `lib/public/js/components/webhooks.js`
     - `lib/public/js/components/telegram-workspace.js`
     - `lib/public/js/components/onboarding/welcome-setup-step.js`
     - `lib/public/js/components/onboarding/welcome-pairing-step.js`
   - Current inconsistency snapshot:
     - `opacity-50` and `opacity-60` both used for disabled states.

6. **[P2 | M] Consider a shared action button wrapper for common save/create/delete states.**
   - [x] Evaluate extraction points in: `lib/public/js/components/envars.js`, `lib/public/js/components/providers.js`, `lib/public/js/components/webhooks.js`, `lib/public/js/components/models.js`, `lib/public/js/components/pairings.js`, `lib/public/js/components/device-pairings.js`.
   - Current inconsistency snapshot:
     - Repeated action-label + loading-label + disabled-guard patterns.

7. **[P2 | M] Extract a shared modal shell wrapper for non-confirm custom modals.**
   - [x] Factor shared overlay/panel shell from:
     - `lib/public/js/components/webhooks.js` (`CreateWebhookModal`)
     - `lib/public/js/components/credentials-modal.js`
   - [x] Keep parity with `lib/public/js/components/confirm-dialog.js` behavior (overlay click + Escape semantics).
   - Current inconsistency snapshot:
     - Same modal shell classes/structure repeated with minor differences.
