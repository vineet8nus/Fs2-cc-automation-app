import { AbapObjectType } from "../types";

// FUNCTION_GROUP stays unsupported: a function group is a container of
// function modules/includes, not a single addressable source unit, and this
// app's intake has no "which function module" field — see
// RealAdtClient.readObjectSource's FUNCTION_GROUP branch.
export const OBJECT_TYPES: { value: AbapObjectType; label: string; icon: string; supported: boolean }[] = [
  { value: "PROGRAM", label: "Program / Include", icon: "source-code", supported: true },
  { value: "CLASS", label: "Class", icon: "class", supported: true },
  { value: "FUNCTION_GROUP", label: "Function group", icon: "function", supported: false },
  { value: "INCLUDE", label: "Include", icon: "documents", supported: true },
  { value: "INTERFACE", label: "Interface", icon: "puzzle", supported: true },
  { value: "CDS_VIEW", label: "CDS view", icon: "grid", supported: true },
];

export function objectTypeLabel(type: AbapObjectType): string {
  return OBJECT_TYPES.find((t) => t.value === type)?.label ?? type;
}
