import { AbapObjectType } from "../types";

export const OBJECT_TYPES: { value: AbapObjectType; label: string; icon: string; supported: boolean }[] = [
  { value: "PROGRAM", label: "Program / Include", icon: "source-code", supported: true },
  { value: "CLASS", label: "Class", icon: "class", supported: false },
  { value: "FUNCTION_GROUP", label: "Function group", icon: "function", supported: false },
  { value: "INCLUDE", label: "Include", icon: "documents", supported: false },
  { value: "INTERFACE", label: "Interface", icon: "puzzle", supported: false },
  { value: "CDS_VIEW", label: "CDS view", icon: "grid", supported: false },
];

export function objectTypeLabel(type: AbapObjectType): string {
  return OBJECT_TYPES.find((t) => t.value === type)?.label ?? type;
}
