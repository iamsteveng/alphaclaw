import { h } from "https://esm.sh/preact";
import htm from "https://esm.sh/htm";

const html = htm.bind(h);

export const InfoTooltip = ({ text = "", widthClass = "w-64" }) => html`
  <span class="relative group inline-flex items-center cursor-default select-none">
    <span
      class="inline-flex h-4 w-4 items-center justify-center rounded-full border border-gray-500 text-[10px] text-gray-400 cursor-default"
      aria-label=${text}
      >?</span
    >
    <span
      class=${`pointer-events-none absolute left-1/2 top-full z-10 mt-2 hidden -translate-x-1/2 rounded-md border border-border bg-modal px-2 py-1 text-[11px] text-gray-300 shadow-lg group-hover:block ${widthClass}`}
      >${text}</span
    >
  </span>
`;
