import "./styles.css";
import * as api from "./api";
import type { LoadResp } from "./types";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export function say(text: string) {
  $("message").textContent = text;
}

async function refreshTakes(select?: string) {
  const takes = await api.listTakes();
  const sel = $<HTMLSelectElement>("takes");
  sel.innerHTML = `<option value="">Open a take...</option>` + takes.map((t) => `<option>${t}</option>`).join("");
  if (select) sel.value = select;
}

export async function opened(r: LoadResp) {
  say(r.info.warning ?? `${r.info.name}: ${r.info.duration_s.toFixed(1)} s`);
  await refreshTakes(r.info.name);
}

$<HTMLSelectElement>("takes").addEventListener("change", async (e) => {
  const name = (e.target as HTMLSelectElement).value;
  if (!name) return;
  say(`Analyzing ${name}...`);
  try {
    await opened(await api.openTake(name));
  } catch (err) {
    say((err as Error).message);
  }
});

refreshTakes().catch((e) => say(e.message));
