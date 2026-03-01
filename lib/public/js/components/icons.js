import { h } from "https://esm.sh/preact";
import htm from "https://esm.sh/htm";

const html = htm.bind(h);

export const ChevronDownIcon = ({ className = "" }) => html`
  <svg
    class=${className}
    width="12"
    height="12"
    viewBox="0 0 20 20"
    fill="none"
    aria-hidden="true"
  >
    <path
      d="M5 7.5L10 12.5L15 7.5"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
  </svg>
`;

export const CloseIcon = ({ className = "" }) => html`
  <svg
    class=${className}
    width="16"
    height="16"
    viewBox="0 0 16 16"
    fill="none"
    aria-hidden="true"
  >
    <path
      d="M4 4L12 12M12 4L4 12"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
  </svg>
`;
