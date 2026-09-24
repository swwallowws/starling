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
