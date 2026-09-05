import { useEffect, useRef, useState } from "react";
import { currentScientificSettlement, ScientificWorkerClient, type ScientificSettlement } from "./design-scientific-client.ts";
import type { ScientificInputs, ScientificKind } from "./design-scientific.ts";

/** Input object identity is a render-time guard, before effect cleanup runs. */
export function useScientificComputation<K extends ScientificKind>(kind: K, artifactIdentity: string, input: ScientificInputs[K] | undefined) {
  const client = useRef<ScientificWorkerClient | undefined>(undefined);
  const [settled, setSettled] = useState<ScientificSettlement<K>>();
  useEffect(() => {
    if (!input) { client.current?.cancel(); return; }
    const abort = new AbortController();
    client.current ??= new ScientificWorkerClient();
    void client.current.run(kind, artifactIdentity, input, abort.signal).then(
      (result) => { if (!abort.signal.aborted) setSettled({ input, artifactIdentity, result }); },
      (error: unknown) => { if (!abort.signal.aborted) setSettled({ input, artifactIdentity, error: error instanceof Error ? error.message : "Scientific computation failed." }); },
    );
    return () => abort.abort();
  }, [kind, artifactIdentity, input]);
  useEffect(() => () => client.current?.dispose(), []);
  const current = currentScientificSettlement(settled, input, artifactIdentity);
  return { result: current?.result, error: current?.error, pending: Boolean(input && !current) };
}
