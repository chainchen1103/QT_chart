// Small DOM builders for the settings windows: elements, check boxes, color and number inputs, buttons.

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}
export function checkbox(checked: boolean, title: string, onChange: (v: boolean) => void): HTMLInputElement {
  const c = el("input");
  c.type = "checkbox";
  c.checked = checked;
  c.title = title;
  c.onchange = () => onChange(c.checked);
  return c;
}
export function colorInput(value: string, onInput: (v: string) => void, title = "顏色"): HTMLInputElement {
  const c = el("input");
  c.type = "color";
  c.value = value;
  c.title = title;
  c.oninput = () => onInput(c.value);
  return c;
}
export function textButton(text: string, cls: string, onClick: () => void, title = ""): HTMLButtonElement {
  const b = el("button", cls, text);
  b.type = "button";
  if (title) b.title = title;
  b.onclick = onClick;
  return b;
}
export function labelled(input: HTMLInputElement, text: string, title = ""): HTMLLabelElement {
  const l = el("label", "pop-check");
  l.append(input, document.createTextNode(text));
  if (title) l.title = title;
  return l;
}
export const lbl = (text: string) => el("span", "pop-lbl", text);
/** Mark an input red for a moment. */
export function flagBad(input: HTMLInputElement) {
  input.classList.add("bad");
  setTimeout(() => input.classList.remove("bad"), 1200);
}
/** Number box that only accepts values in range; a bad entry flashes red and goes back. */
export function numInput(
  value: number,
  r: { min: number; max: number },
  o: { title: string; width?: number; step?: string; int?: boolean },
  onCommit: (v: number) => void,
): HTMLInputElement {
  const i = el("input");
  i.type = "number";
  i.min = String(r.min);
  i.max = String(r.max);
  i.step = o.step ?? "1";
  i.value = String(value);
  i.title = o.title;
  if (o.width) i.style.width = `${o.width}px`;
  let cur = value;
  i.onchange = () => {
    const v = Number(i.value);
    if (i.value.trim() === "" || !Number.isFinite(v) || v < r.min || v > r.max || (o.int !== false && !Number.isInteger(v))) {
      flagBad(i);
      i.value = String(cur);
      return;
    }
    cur = v;
    onCommit(v);
  };
  i.onkeydown = (e) => {
    if (e.key === "Enter") i.blur();
  };
  return i;
}

/** A keyboard shortcut as small keycaps: "Alt+Shift+R" → [Alt] [Shift] [R]. */
export function keycaps(keys: string, cls = "keys"): HTMLElement {
  const box = el("span", cls);
  for (const k of keys.split("+")) box.append(el("kbd", "kbd", k));
  return box;
}

/** A row in a right-click menu: the action, and its shortcut on the right. */
export function menuItem(text: string, onClick: () => void, hint = ""): HTMLButtonElement {
  const b = el("button", "menu-item");
  b.type = "button";
  b.append(el("span", "", text));
  if (hint) b.append(keycaps(hint, "keys menu-hint"));
  b.onclick = onClick;
  return b;
}

/** A box text is typed into (a redraw would wipe what is being typed); not a button, check box or select. */
export function isTextEntry(t: Element | null): boolean {
  if (!t) return false;
  if (t.tagName === "TEXTAREA" || (t as HTMLElement).isContentEditable) return true;
  return t.tagName === "INPUT" && ["text", "number", "password", "search", "email", "tel", "url"].includes((t as HTMLInputElement).type);
}

/** True while typing in a text box (keyboard shortcuts stay out of the way). */
export function isTyping(t: Element | null): boolean {
  return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || (t as HTMLElement).isContentEditable);
}
