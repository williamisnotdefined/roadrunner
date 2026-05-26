import type { Readable, Writable } from "node:stream";

import type { Widgets } from "blessed";

import type { FocusPanel } from "./run-tui-navigation.js";

export interface RunTuiElements {
  actions: Widgets.BoxElement;
  details: Widgets.BoxElement;
  footer: Widgets.BoxElement;
  header: Widgets.BoxElement;
  log: Widgets.BoxElement;
  logs: Widgets.ListElement;
  modal: Widgets.BoxElement;
  screen: Widgets.Screen;
  table: Widgets.ListTableElement;
}

export function createRunTuiElements(blessed: typeof import("blessed"), input: Readable, output: Writable): RunTuiElements {
  const screen = blessed.screen({ fullUnicode: true, input: input as never, output: output as never, smartCSR: true, title: "Roadrunner" });
  const elements = {
    screen,
    header: blessed.box({ height: 3, left: 0, tags: true, top: 0, width: "100%" }),
    table: blessed.listtable({ border: "line", height: "45%", keys: false, left: 0, mouse: true, pad: 1, tags: true, top: 3, width: "100%" }),
    details: blessed.box({ border: "line", height: "35%", label: " Details ", left: 0, tags: true, top: "48%", width: "38%" }),
    logs: blessed.list({ border: "line", height: "35%", keys: false, label: " Logs ", left: "38%", mouse: true, tags: true, top: "48%", width: "25%" }),
    log: blessed.box({ alwaysScroll: true, border: "line", height: "35%", label: " Log Viewer ", left: "63%", mouse: true, scrollable: true, scrollbar: { ch: " ", track: { bg: "black" }, style: { bg: "cyan" } }, tags: true, top: "48%", vi: true, width: "37%" }),
    actions: blessed.box({ bottom: 1, height: 1, left: 0, mouse: true, tags: true, width: "100%" }),
    footer: blessed.box({ bottom: 0, height: 1, left: 0, tags: true, width: "100%" }),
    modal: blessed.box({ border: "line", height: 9, hidden: true, label: " Attention ", left: "center", padding: 1, tags: true, top: "center", width: "70%" }),
  } satisfies RunTuiElements;
  for (const element of [elements.header, elements.table, elements.details, elements.logs, elements.log, elements.actions, elements.footer, elements.modal]) screen.append(element);
  screen.enableMouse();
  return elements;
}

export function setFocusBorders(elements: RunTuiElements, focus: FocusPanel): void {
  elements.table.style.border = { fg: focus === "tasks" ? "cyan" : "gray" };
  elements.logs.style.border = { fg: focus === "logs" ? "cyan" : "gray" };
  elements.log.style.border = { fg: focus === "log" ? "cyan" : "gray" };
}
