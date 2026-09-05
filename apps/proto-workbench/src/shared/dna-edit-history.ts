import type { DesignEditCommand, DnaSourceAnnotation } from "./dna-edits.ts";

export interface DnaEditBaseline {
  construct: string;
  order: string[];
  orientations: Record<string, "forward" | "reverse">;
  annotations: DnaSourceAnnotation[];
}

/** Semantic inverses use the same checked source transaction as edits. */
export function inverseDesignCommands(commands: DesignEditCommand[], baseline: DnaEditBaseline): DesignEditCommand[] {
  let order = [...baseline.order];
  const orientations = {...baseline.orientations};
  const annotations = new Map(baseline.annotations.map(a => [a.id, structuredClone(a)]));
  const inverses: DesignEditCommand[] = [];
  for (const command of commands) {
    if (command.construct !== baseline.construct) throw new Error("Edit history cannot cross constructs.");
    switch (command.type) {
      case "reorder_occurrences":
        if (command.instance_ids.length !== order.length || new Set(command.instance_ids).size !== order.length || command.instance_ids.some(id => !order.includes(id))) throw new Error("Edit history order must preserve every occurrence.");
        inverses.unshift({type: command.type, construct: command.construct, instance_ids: order});
        order = [...command.instance_ids];
        break;
      case "set_orientation":
        if (!(command.instance_id in orientations)) throw new Error("Edit history occurrence is unknown.");
        inverses.unshift({...command, orientation: orientations[command.instance_id]});
        orientations[command.instance_id] = command.orientation;
        break;
      case "upsert_annotation": {
        const previous = annotations.get(command.annotation.id);
        inverses.unshift(previous ? {type: "upsert_annotation", construct: command.construct, annotation: previous} : {type: "delete_annotation", construct: command.construct, annotation_id: command.annotation.id});
        annotations.set(command.annotation.id, structuredClone(command.annotation));
        break;
      }
      case "delete_annotation": {
        const previous = annotations.get(command.annotation_id);
        if (!previous) throw new Error("Edit history annotation is unknown.");
        inverses.unshift({type: "upsert_annotation", construct: command.construct, annotation: previous});
        annotations.delete(command.annotation_id);
        break;
      }
    }
  }
  return inverses;
}
