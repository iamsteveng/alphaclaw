import { h } from "https://esm.sh/preact";
import { useState, useEffect, useRef } from "https://esm.sh/preact/hooks";
import htm from "https://esm.sh/htm";
import {
  runOnboard,
  verifyGithubOnboardingRepo,
  fetchModels,
  fetchCodexStatus,
  disconnectCodex,
  exchangeCodexOAuth,
  fetchStatus,
  fetchPairings,
  approvePairing,
  rejectPairing,
} from "../lib/api.js";
import { usePolling } from "../hooks/usePolling.js";
import {
  getModelProvider,
  getFeaturedModels,
  getVisibleAiFieldKeys,
} from "../lib/model-config.js";
import {
  kWelcomeGroups,
  isValidGithubRepoInput,
} from "./onboarding/welcome-config.js";
import { WelcomeHeader } from "./onboarding/welcome-header.js";
import { WelcomeSetupStep } from "./onboarding/welcome-setup-step.js";
import { WelcomeFormStep } from "./onboarding/welcome-form-step.js";
import { WelcomePairingStep } from "./onboarding/welcome-pairing-step.js";
import {
  getPreferredPairingChannel,
  isChannelPaired,
} from "./onboarding/pairing-utils.js";
const html = htm.bind(h);
const kOnboardingStorageKey = "openclaw_setup";
const kOnboardingStepKey = "_step";
const kPairingChannelKey = "_pairingChannel";
const kMaxOnboardingVars = 64;
const kMaxEnvKeyLength = 128;
const kMaxEnvValueLength = 4096;

export const Welcome = ({ onComplete }) => {
  const [initialSetupState] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem(kOnboardingStorageKey) || "{}");
    } catch {
      return {};
    }
  });
  const [vals, setVals] = useState(() => ({ ...initialSetupState }));
  const [models, setModels] = useState([]);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [modelsError, setModelsError] = useState(null);
  const [showAllModels, setShowAllModels] = useState(false);
  const [codexStatus, setCodexStatus] = useState({ connected: false });
  const [codexLoading, setCodexLoading] = useState(true);
  const [codexManualInput, setCodexManualInput] = useState("");
  const [codexExchanging, setCodexExchanging] = useState(false);
  const [codexAuthStarted, setCodexAuthStarted] = useState(false);
  const [codexAuthWaiting, setCodexAuthWaiting] = useState(false);
  const [loading, setLoading] = useState(false);
  const [githubStepLoading, setGithubStepLoading] = useState(false);
  const [error, setError] = useState(null);
  const codexPopupPollRef = useRef(null);

  useEffect(() => {
    fetchModels()
      .then((result) => {
        const list = Array.isArray(result.models) ? result.models : [];
        const featured = getFeaturedModels(list);
        setModels(list);
        if (!vals.MODEL_KEY && list.length > 0) {
          const defaultModel = featured[0] || list[0];
          setVals((prev) => ({ ...prev, MODEL_KEY: defaultModel.key }));
        }
      })
      .catch(() => setModelsError("Failed to load models"))
      .finally(() => setModelsLoading(false));
  }, []);

  const refreshCodexStatus = async () => {
    try {
      const status = await fetchCodexStatus();
      setCodexStatus(status);
      if (status?.connected) {
        setCodexAuthStarted(false);
        setCodexAuthWaiting(false);
      }
    } catch {
      setCodexStatus({ connected: false });
    } finally {
      setCodexLoading(false);
    }
  };

  useEffect(() => {
    refreshCodexStatus();
  }, []);

  useEffect(() => {
    const onMessage = async (e) => {
      if (e.data?.codex === "success") {
        await refreshCodexStatus();
      }
      if (e.data?.codex === "error") {
        setError(`Codex auth failed: ${e.data.message || "unknown error"}`);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  useEffect(
    () => () => {
      if (codexPopupPollRef.current) {
        clearInterval(codexPopupPollRef.current);
        codexPopupPollRef.current = null;
      }
    },
    [],
  );

  const set = (key, value) => setVals((prev) => ({ ...prev, [key]: value }));

  const selectedProvider = getModelProvider(vals.MODEL_KEY);
  const featuredModels = getFeaturedModels(models);
  const baseModelOptions = showAllModels
    ? models
    : featuredModels.length > 0
      ? featuredModels
      : models;
  const selectedModelOption = models.find(
    (model) => model.key === vals.MODEL_KEY,
  );
  const modelOptions =
    selectedModelOption &&
    !baseModelOptions.some((model) => model.key === selectedModelOption.key)
      ? [...baseModelOptions, selectedModelOption]
      : baseModelOptions;
  const canToggleFullCatalog =
    featuredModels.length > 0 && models.length > featuredModels.length;
  const visibleAiFieldKeys = getVisibleAiFieldKeys(selectedProvider);
  const hasAi =
    selectedProvider === "anthropic"
      ? !!(vals.ANTHROPIC_API_KEY || vals.ANTHROPIC_TOKEN)
      : selectedProvider === "openai"
        ? !!vals.OPENAI_API_KEY
        : selectedProvider === "google"
          ? !!vals.GEMINI_API_KEY
          : selectedProvider === "openai-codex"
            ? !!(codexStatus.connected || vals.OPENAI_API_KEY)
            : false;

  const allValid = kWelcomeGroups.every((g) => g.validate(vals, { hasAi }));
  const kSetupStepIndex = kWelcomeGroups.length;
  const kPairingStepIndex = kSetupStepIndex + 1;
  const [step, setStep] = useState(() => {
    const parsedStep = Number.parseInt(
      String(initialSetupState?.[kOnboardingStepKey] || ""),
      10,
    );
    if (!Number.isFinite(parsedStep)) return 0;
    return Math.max(0, Math.min(kPairingStepIndex, parsedStep));
  });
  const [pairingError, setPairingError] = useState(null);
  const [pairingComplete, setPairingComplete] = useState(false);
  const isSetupStep = step === kSetupStepIndex;
  const isPairingStep = step === kPairingStepIndex;
  const activeGroup = step < kSetupStepIndex ? kWelcomeGroups[step] : null;
  const currentGroupValid = activeGroup
    ? activeGroup.validate(vals, { hasAi })
    : false;
  const selectedPairingChannel = String(
    vals[kPairingChannelKey] || getPreferredPairingChannel(vals),
  );
  const pairingStatusPoll = usePolling(fetchStatus, 3000, {
    enabled: isPairingStep,
  });
  const pairingRequestsPoll = usePolling(
    async () => {
      const payload = await fetchPairings();
      const allPending = payload.pending || [];
      return allPending.filter((p) => p.channel === selectedPairingChannel);
    },
    1000,
    { enabled: isPairingStep && !!selectedPairingChannel },
  );
  const pairingChannels = pairingStatusPoll.data?.channels || {};
  const canFinishPairing = isChannelPaired(pairingChannels, selectedPairingChannel);

  useEffect(() => {
    if (isPairingStep && canFinishPairing) {
      setPairingComplete(true);
    }
  }, [isPairingStep, canFinishPairing]);

  useEffect(() => {
    localStorage.setItem(
      kOnboardingStorageKey,
      JSON.stringify({
        ...vals,
        [kOnboardingStepKey]: step,
      }),
    );
  }, [vals, step]);

  const startCodexAuth = () => {
    if (codexStatus.connected) return;
    setCodexAuthStarted(true);
    setCodexAuthWaiting(true);
    const authUrl = "/auth/codex/start";
    const popup = window.open(
      authUrl,
      "codex-auth",
      "popup=yes,width=640,height=780",
    );
    if (!popup || popup.closed) {
      setCodexAuthWaiting(false);
      window.location.href = authUrl;
      return;
    }
    if (codexPopupPollRef.current) {
      clearInterval(codexPopupPollRef.current);
    }
    codexPopupPollRef.current = setInterval(() => {
      if (popup.closed) {
        clearInterval(codexPopupPollRef.current);
        codexPopupPollRef.current = null;
        setCodexAuthWaiting(false);
      }
    }, 500);
  };

  const completeCodexAuth = async () => {
    if (!codexManualInput.trim() || codexExchanging) return;
    setCodexExchanging(true);
    setError(null);
    try {
      const result = await exchangeCodexOAuth(codexManualInput.trim());
      if (!result.ok)
        throw new Error(result.error || "Codex OAuth exchange failed");
      setCodexManualInput("");
      setCodexAuthStarted(false);
      setCodexAuthWaiting(false);
      await refreshCodexStatus();
    } catch (err) {
      setError(err.message || "Codex OAuth exchange failed");
    } finally {
      setCodexExchanging(false);
    }
  };

  const handleCodexDisconnect = async () => {
    const result = await disconnectCodex();
    if (!result.ok) {
      setError(result.error || "Failed to disconnect Codex");
      return;
    }
    setCodexAuthStarted(false);
    setCodexAuthWaiting(false);
    setCodexManualInput("");
    await refreshCodexStatus();
  };

  const handleSubmit = async () => {
    if (!allValid || loading) return;
    const vars = Object.entries(vals)
      .filter(
        ([key]) => key !== "MODEL_KEY" && !String(key || "").startsWith("_"),
      )
      .filter(([, v]) => v)
      .map(([key, value]) => ({ key, value }));
    const preflightError = (() => {
      if (!vals.MODEL_KEY || !String(vals.MODEL_KEY).includes("/")) {
        return "A model selection is required";
      }
      if (vars.length > kMaxOnboardingVars) {
        return `Too many environment variables (max ${kMaxOnboardingVars})`;
      }
      for (const entry of vars) {
        const key = String(entry?.key || "");
        const value = String(entry?.value || "");
        if (!key) return "Each variable must include a key";
        if (key.length > kMaxEnvKeyLength) {
          return `Variable key is too long: ${key.slice(0, 32)}...`;
        }
        if (value.length > kMaxEnvValueLength) {
          return `Value too long for ${key} (max ${kMaxEnvValueLength} chars)`;
        }
      }
      if (!vals.GITHUB_TOKEN || !isValidGithubRepoInput(vals.GITHUB_WORKSPACE_REPO)) {
        return 'GITHUB_WORKSPACE_REPO must be in "owner/repo" format.';
      }
      return "";
    })();
    if (preflightError) {
      setError(preflightError);
      setStep(Math.max(0, kWelcomeGroups.findIndex((g) => g.id === "github")));
      return;
    }
    setStep(kSetupStepIndex);
    setLoading(true);
    setError(null);
    setPairingError(null);

    try {
      const result = await runOnboard(vars, vals.MODEL_KEY);
      if (!result.ok) throw new Error(result.error || "Onboarding failed");
      const pairingChannel = getPreferredPairingChannel(vals);
      if (!pairingChannel) {
        throw new Error("No Telegram or Discord bot token configured for pairing.");
      }
      setVals((prev) => ({
        ...prev,
        [kPairingChannelKey]: pairingChannel,
      }));
      setLoading(false);
      setStep(kPairingStepIndex);
      setPairingComplete(false);
    } catch (err) {
      console.error("Onboard error:", err);
      setError(err.message);
      setLoading(false);
    }
  };

  const handlePairingApprove = async (id, channel) => {
    try {
      setPairingError(null);
      const result = await approvePairing(id, channel);
      if (!result.ok) throw new Error(result.error || "Could not approve pairing");
      setPairingComplete(true);
      pairingRequestsPoll.refresh();
      pairingStatusPoll.refresh();
    } catch (err) {
      setPairingError(err.message || "Could not approve pairing");
    }
  };

  const handlePairingReject = async (id, channel) => {
    try {
      setPairingError(null);
      const result = await rejectPairing(id, channel);
      if (!result.ok) throw new Error(result.error || "Could not reject pairing");
      pairingRequestsPoll.refresh();
    } catch (err) {
      setPairingError(err.message || "Could not reject pairing");
    }
  };

  const finishOnboarding = () => {
    localStorage.removeItem(kOnboardingStorageKey);
    onComplete();
  };

  const goBack = () => {
    if (isSetupStep) return;
    setError(null);
    setStep((prev) => Math.max(0, prev - 1));
  };
  const goBackFromSetupError = () => {
    setLoading(false);
    setStep(kWelcomeGroups.length - 1);
  };

  const goNext = async () => {
    if (!activeGroup || !currentGroupValid) return;
    setError(null);
    if (activeGroup.id === "github") {
      setGithubStepLoading(true);
      try {
        const result = await verifyGithubOnboardingRepo(
          vals.GITHUB_WORKSPACE_REPO,
          vals.GITHUB_TOKEN,
        );
        if (!result?.ok) {
          setError(result?.error || "GitHub verification failed");
          return;
        }
      } catch (err) {
        setError(err?.message || "GitHub verification failed");
        return;
      } finally {
        setGithubStepLoading(false);
      }
    }
    setStep((prev) => Math.min(kWelcomeGroups.length - 1, prev + 1));
  };

  const activeStepLabel = isSetupStep
    ? "Initializing"
    : isPairingStep
      ? "Pairing"
      : activeGroup?.title || "Setup";
  const stepNumber = isSetupStep
    ? kWelcomeGroups.length + 1
    : isPairingStep
      ? kWelcomeGroups.length + 2
      : step + 1;

  return html`
    <div class="max-w-lg w-full space-y-5">
      <${WelcomeHeader}
        groups=${kWelcomeGroups}
        step=${step}
        isSetupStep=${isSetupStep}
        isPairingStep=${isPairingStep}
        stepNumber=${stepNumber}
        activeStepLabel=${activeStepLabel}
      />

      <div class="bg-surface border border-border rounded-xl p-4 space-y-3">
        ${isSetupStep
          ? html`<${WelcomeSetupStep}
              error=${error}
              loading=${loading}
              onRetry=${handleSubmit}
              onBack=${goBackFromSetupError}
            />`
          : isPairingStep
            ? html`<${WelcomePairingStep}
                channel=${selectedPairingChannel}
                pairings=${pairingRequestsPoll.data || []}
                channels=${pairingChannels}
                loading=${!pairingStatusPoll.data}
                error=${pairingError}
                onApprove=${handlePairingApprove}
                onReject=${handlePairingReject}
                canFinish=${pairingComplete || canFinishPairing}
                onContinue=${finishOnboarding}
              />`
          : html`
              <${WelcomeFormStep}
                activeGroup=${activeGroup}
                vals=${vals}
                hasAi=${hasAi}
                setValue=${set}
                modelOptions=${modelOptions}
                modelsLoading=${modelsLoading}
                modelsError=${modelsError}
                canToggleFullCatalog=${canToggleFullCatalog}
                showAllModels=${showAllModels}
                setShowAllModels=${setShowAllModels}
                selectedProvider=${selectedProvider}
                codexLoading=${codexLoading}
                codexStatus=${codexStatus}
                startCodexAuth=${startCodexAuth}
                handleCodexDisconnect=${handleCodexDisconnect}
                codexAuthStarted=${codexAuthStarted}
                codexAuthWaiting=${codexAuthWaiting}
                codexManualInput=${codexManualInput}
                setCodexManualInput=${setCodexManualInput}
                completeCodexAuth=${completeCodexAuth}
                codexExchanging=${codexExchanging}
                visibleAiFieldKeys=${visibleAiFieldKeys}
                error=${error}
                step=${step}
                totalGroups=${kWelcomeGroups.length}
                currentGroupValid=${currentGroupValid}
                goBack=${goBack}
                goNext=${goNext}
                loading=${loading}
                githubStepLoading=${githubStepLoading}
                allValid=${allValid}
                handleSubmit=${handleSubmit}
              />
            `}
      </div>
    </div>
  `;
};
