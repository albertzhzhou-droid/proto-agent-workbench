import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor/editor/editor.api.js";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/language/json/json.worker?worker";
import "monaco-editor/language/json/monaco.contribution.js";
import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App.tsx";
import "./fonts.css";
import "./styles.css";
import "./workbench-theme.css";
import "./paper-workbench.css";
import "./workbench-typography.css";
import "./compute-workspace.css";
import "./chat-workspace.css";
import "./chem-workspace.css";
import "./paper-motion.css";

type MonacoWorker = new () => Worker;
const workerScope = globalThis as typeof globalThis & {
  MonacoEnvironment: { getWorker(_moduleId: string, label: string): Worker };
};

workerScope.MonacoEnvironment = {
  getWorker(_moduleId, label) {
    const WorkerConstructor: MonacoWorker = label === "json" ? JsonWorker : EditorWorker;
    return new WorkerConstructor();
  },
};
loader.config({ monaco });

// Load measuring fonts before mounting canvas and Monaco views. Remaining
// weights and italics load on demand through the same local @font-face rules.
void Promise.all([
  document.fonts.load('400 14px "Anthropic Sans Text"'),
  document.fonts.load('400 28px "Anthropic Serif Display"'),
  document.fonts.load('400 14px "Anthropic Serif Text"'),
  document.fonts.load('400 12px "Anthropic Mono Web"'),
]).catch(() => undefined).then(() => {
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode><App /></React.StrictMode>,
  );
});
