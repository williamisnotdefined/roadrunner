import type { Widgets } from "blessed";

/* v8 ignore start -- interactive textbox behavior is exercised manually in a real TTY. */
export function promptForDirective(blessed: typeof import("blessed"), screen: Widgets.Screen, onSubmit: (text: string) => void): void {
  const input = blessed.textbox({ border: "line", height: 5, inputOnFocus: true, keys: true, label: " Operator Directive ", left: "10%", mouse: true, tags: true, top: "center", width: "80%" });
  screen.append(input);
  input.focus();
  input.key(["escape"], () => {
    input.destroy();
    screen.render();
  });
  input.key(["enter"], () => {
    const text = String(input.getValue()).trim();
    input.destroy();
    if (text.length > 0) onSubmit(text);
    screen.render();
  });
  screen.render();
}
/* v8 ignore stop */
