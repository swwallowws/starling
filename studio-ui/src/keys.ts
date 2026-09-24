export type SpaceAction = "none" | "ignore" | "native" | "play" | "record";

/** Text-like inputs where Space types a character. */
const TYPING = new Set(["text", "number", "search", "email", "url", "password", "tel", ""]);

/** What Space should do. Sliders and radios are what people touch while
 *  listening, so Space still plays there; typing fields, selects, checkboxes
 *  and buttons keep Space for themselves. Key repeat never toggles twice. */
export function spaceAction(e: { code: string; repeat: boolean; target: EventTarget | null }, recording: boolean): SpaceAction {
  if (e.code !== "Space") return "none";
  const t = e.target as HTMLElement | null;
  const tag = t?.tagName ?? "";
  if (tag === "TEXTAREA" || tag === "SELECT" || tag === "BUTTON") return "native";
  if (tag === "INPUT") {
    const type = (t as HTMLInputElement).type;
    if (TYPING.has(type) || type === "checkbox") return "native";
  }
  if (e.repeat) return "ignore";
  return recording ? "record" : "play";
}

export type ZoomKey = "none" | "in" | "out" | "fit";

/** + and - zoom the roll, 0 fits it. Not while typing, in a select, or with
 *  Cmd/Ctrl held (that is the browser's own page zoom). */
export function zoomKey(e: { key: string; metaKey: boolean; ctrlKey: boolean; target: EventTarget | null }): ZoomKey {
  if (e.metaKey || e.ctrlKey) return "none";
  const t = e.target as HTMLElement | null;
  const tag = t?.tagName ?? "";
  if (tag === "TEXTAREA" || tag === "SELECT") return "none";
  if (tag === "INPUT" && TYPING.has((t as HTMLInputElement).type)) return "none";
  if (e.key === "+" || e.key === "=") return "in";
  if (e.key === "-" || e.key === "_") return "out";
  if (e.key === "0") return "fit";
  return "none";
}
