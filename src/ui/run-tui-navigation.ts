export type FocusPanel = "log" | "logs" | "tasks";

const focusOrder: FocusPanel[] = ["tasks", "logs", "log"];

export function nextFocus(focus: FocusPanel): FocusPanel {
  return focusOrder[(focusOrder.indexOf(focus) + 1) % focusOrder.length]!;
}

export function previousFocus(focus: FocusPanel): FocusPanel {
  return focusOrder[(focusOrder.indexOf(focus) + focusOrder.length - 1) % focusOrder.length]!;
}
