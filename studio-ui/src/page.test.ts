// The studio page's markup, read as text: the same controls as the demo and the
// other studios (design controls.css and icon buttons).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const page = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const header = page.split('<header class="ds-header">')[1].split("</header>")[0];
const footer = page.split('<footer class="bar ds-footer">')[1].split("</footer>")[0];
const side = page.split('<aside id="side"')[1].split("</aside>")[0];

describe("studio page", () => {
  it("starts the header with Record and Play as icon buttons, as in the demo", () => {
    const rec = header.indexOf('id="record"'), play = header.indexOf('id="play"');
    expect(rec).toBeGreaterThan(-1);
    expect(play).toBeGreaterThan(rec);
    expect(header).toMatch(/<button id="record"[^>]*data-icon="record"[^>]*data-pressed-icon="stop"/);
    expect(header).toMatch(/<button id="play"[^>]*data-icon="play"[^>]*data-key="Space"/);
    expect(header.indexOf('id="play"')).toBeLessThan(header.indexOf('id="take-name"'));
  });

  it("ends the header with the colour mode switch, the one every product shares", () => {
    expect(header).toMatch(/<div id="modes" class="modes"><\/div>\s*$/);
    expect(page).toMatch(/localStorage\.getItem\("swwallowws:mode"\)/);
  });

  it("has the shared header: the wordmark, no tagline", () => {
    expect(header).toMatch(/class="ds-wordmark">Starling<span class="dot">\.<\/span>/);
    expect(header).not.toMatch(/simply/);
  });

  it("keeps the root note out of sight until a tuning needs it, and says it plainly", () => {
    expect(header).toMatch(/<span id="root-note" class="root-note" hidden>/);
    expect(header).toMatch(/Root note <select id="anchor"/);
    expect(page).not.toMatch(/>Anchor </);
  });

  it("puts what you hear next to Play, as a joined choice", () => {
    expect(header).toMatch(/class="ds-choice[^"]*" role="radiogroup" aria-label="Listen to"/);
    expect(header.match(/name="listen"/g)).toHaveLength(3);
  });

  it("uses the design's field and selects in the header", () => {
    expect(header).toMatch(/<input id="take-name" class="ds-field[ "]/);
    for (const id of ["takes", "tuning", "anchor"]) expect(header).toMatch(new RegExp(`<select id="${id}" class="ds-select"`));
  });

  it("offers the starling's song when there is no take, as the demo does", () => {
    expect(page).toMatch(/No mic handy\? <button id="sample-link"[^>]*>Try a starling's song\.<\/button>/);
  });

  it("saves from the side, under the settings: fill squares for the formats, one primary Save", () => {
    expect(side).toMatch(/<div id="controls"><\/div>[\s\S]*class="save-box"/);
    expect(side.match(/<label class="ds-check"[^>]*><input type="checkbox" name="format"/g)).toHaveLength(3);
    expect(side).toMatch(/<button id="save" class="ds-button primary[ "]/);
    expect(page).not.toMatch(/Play \(Space\)/);
  });

  it("keeps the footer to one line, as in the other studios: where takes stay, and Get in touch", () => {
    expect(footer).toMatch(/id="privacy"/);
    expect(footer).toMatch(/<div id="contact"/);
    expect(footer).not.toMatch(/name="format"|id="save"|legend/);
  });

  it("folds the roll's key into a corner of the roll", () => {
    expect(page).toMatch(/<details class="roll-key[^"]*">\s*<summary>Key<\/summary>/);
  });
});
