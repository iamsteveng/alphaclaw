import { h } from "https://esm.sh/preact";
import htm from "https://esm.sh/htm";
import { UpdateActionButton } from "./update-action-button.js";

const html = htm.bind(h);

export const GlobalRestartBanner = ({
  visible = false,
  restarting = false,
  onRestart,
}) => {
  if (!visible) return null;
  return html`
    <div class="global-restart-banner">
      <div class="global-restart-banner__content">
        <p class="global-restart-banner__text">
          Gateway restart required to apply pending configuration changes.
        </p>
        <${UpdateActionButton}
          onClick=${onRestart}
          disabled=${restarting}
          loading=${restarting}
          warning=${true}
          idleLabel="Restart Gateway"
          loadingLabel="Restarting..."
          className="global-restart-banner__button"
        />
      </div>
    </div>
  `;
};
