export type RunTuiActionType = "add-directive" | "cleanup" | "exit" | "pause" | "play" | "reconcile" | "restart-task" | "view-logs";

export type RunTuiAction = { text: string; type: "add-directive" } | { type: Exclude<RunTuiActionType, "add-directive"> };

export interface RunTuiFailure {
  details: string[];
  message: string;
  recoverable: boolean;
  title: string;
}
