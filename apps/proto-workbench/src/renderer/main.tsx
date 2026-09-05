import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor/editor/editor.api.js";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/language/json/json.worker?worker";
import "monaco-editor/language/json/monaco.contribution.js";
import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App.tsx";
import "./styles.css";
import "./workbench-theme.css";

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

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
