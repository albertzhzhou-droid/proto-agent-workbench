import { Cpu, createLucideIcon, MessagesSquare, PenTool, SquareFunction } from "lucide-react";

// Product identity: a bonded ring, reserved for Chem rather than a tool category.
export const ChemWorkbenchIcon = createLucideIcon("ChemWorkbench", [
  ["path", { d: "m3 8 6-3.5L15 8v7l-6 3.5L3 15Z", key: "ring" }],
  ["path", { d: "m15 8 4-2.3M15 15l4 2.3", key: "bonds" }],
  ["circle", { cx: "20.3", cy: "4.9", r: "1.5", key: "upper-node" }],
  ["circle", { cx: "20.3", cy: "18.1", r: "1.5", key: "lower-node" }],
]);

// Shared modes have the same identity in both editions, distinct from navigation.
export const WORKSPACE_MODE_ICONS = { chat: MessagesSquare, design: PenTool, compute: Cpu } as const;

// Keep every method card consistent; inputs and disciplines are expressed in text.
export const MethodIcon = SquareFunction;
