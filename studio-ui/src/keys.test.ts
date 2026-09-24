// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { spaceAction } from "./keys";

const el = (html: string) => {
  const d = document.createElement("div");
  d.innerHTML = html;
  return d.firstElementChild!;
};
const ev = (target: Element | null, repeat = false, code = "Space") => ({ code, repeat, target });

describe("spaceAction", () => {
  it("plays from the page and from sliders and radios", () => {
    expect(spaceAction(ev(document.body), false)).toBe("play");
    expect(spaceAction(ev(el('<input type="range">')), false)).toBe("play");
    expect(spaceAction(ev(el('<input type="radio">')), false)).toBe("play");
  });
  it("stops recording instead while recording", () => {
    expect(spaceAction(ev(el('<input type="range">')), true)).toBe("record");
  });
  it("leaves typing fields, selects, checkboxes and buttons alone", () => {
    for (const h of ['<input type="text">', '<input type="number">', "<textarea></textarea>", "<select></select>", '<input type="checkbox">', "<button></button>"]) {
      expect(spaceAction(ev(el(h)), false)).toBe("native");
    }
  });
  it("ignores key repeat and other keys", () => {
    expect(spaceAction(ev(document.body, true), false)).toBe("ignore");
    expect(spaceAction(ev(document.body, false, "Enter"), false)).toBe("none");
  });
});
