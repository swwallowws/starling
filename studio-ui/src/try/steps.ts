// The guided try page's small rules, kept apart from the DOM so they can be tested.

/** Longest take the try page records before stopping on its own. */
export const RECORD_LIMIT_MS = 10_000;

/** True once a recording has run long enough to stop by itself. */
export const recordLimit = (ms: number): boolean => ms >= RECORD_LIMIT_MS;

/** One calm line for a getUserMedia failure. */
export function micMessage(err: unknown): string {
  const name = (err as { name?: unknown } | null)?.name;
  if (name === "NotAllowedError") return "Microphone blocked. Allow it in the browser, or try a starling's song.";
  if (name === "NotFoundError") return "No microphone found. Try a starling's song instead.";
  return "Couldn't start the microphone.";
}

/** The rail's steps, in order. */
export const STEPS = [
  { id: "sing", label: "Sing anything", hint: "Up to about 10 seconds. Stop whenever you like. No mic? Try a starling's song." },
  { id: "midi", label: "See it become MIDI", hint: "Glides stay as bend curves." },
  { id: "tuning", label: "Switch to 53-EDO makam", hint: "Each note moves onto the nearest makam pitch." },
  { id: "play", label: "Play it back" },
];
