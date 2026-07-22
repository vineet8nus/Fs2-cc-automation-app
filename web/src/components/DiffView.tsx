import { diffLines } from "diff";
import { useMemo } from "react";

type LineKind = "added" | "removed" | "context" | "meta";

const LINE_STYLE_BASE: React.CSSProperties = {
  display: "flex",
  gap: "0.5rem",
  padding: "0 0.5rem",
  whiteSpace: "pre-wrap",
  wordBreak: "break-all",
};

const CONTAINER_STYLE: React.CSSProperties = {
  fontFamily: "monospace",
  fontSize: "0.8rem",
  border: "1px solid var(--sapField_BorderColor, #89919a)",
  borderRadius: "0.25rem",
  overflow: "auto",
  maxHeight: "33rem",
};

function DiffLine({ id, line, kind }: { id: string; line: string; kind: LineKind }) {
  if (kind === "meta") {
    return (
      <div style={{ ...LINE_STYLE_BASE, opacity: 0.6, fontStyle: "italic" }}>
        <span style={{ minWidth: "1ch" }} />
        <span>{line || " "}</span>
      </div>
    );
  }
  return (
    <div
      style={{
        ...LINE_STYLE_BASE,
        background: kind === "added" ? "rgba(48, 176, 80, 0.18)" : kind === "removed" ? "rgba(220, 60, 60, 0.18)" : "transparent",
        borderLeft: `3px solid ${kind === "added" ? "var(--sapPositiveElementColor, #107e3e)" : kind === "removed" ? "var(--sapNegativeElementColor, #bb0000)" : "transparent"}`,
      }}
    >
      <span style={{ userSelect: "none", opacity: 0.6, minWidth: "1ch" }}>{kind === "added" ? "+" : kind === "removed" ? "−" : ""}</span>
      <span>{line || " "}</span>
    </div>
  );
}

function lineRows(value: string, kind: LineKind) {
  // diffLines chunks end with a trailing newline (except sometimes the very
  // last chunk) — drop the resulting empty trailing element so we don't
  // render a blank row per chunk.
  const lines = value.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines.map((line, i) => ({ key: `${kind}-${i}-${line}`, line, kind }));
}

/** Read-only, color-coded line diff between two source strings — red for removed, green for added. */
export function DiffView({ oldText, newText }: { oldText: string; newText: string }) {
  const rows = useMemo(() => {
    const parts = diffLines(oldText ?? "", newText ?? "");
    return parts.flatMap((part) => lineRows(part.value, part.added ? "added" : part.removed ? "removed" : "context"));
  }, [oldText, newText]);

  return (
    <div style={CONTAINER_STYLE}>
      {rows.map(({ key, line, kind }) => (
        <DiffLine key={key} id={key} line={line} kind={kind} />
      ))}
    </div>
  );
}

/** Read-only, color-coded rendering of an already-computed unified diff (git diff text) — +/- prefixes drive the coloring. */
export function RawDiffView({ text }: { text: string }) {
  const rows = useMemo(() => {
    return text.split("\n").map((raw, i) => {
      let kind: LineKind;
      let line = raw;
      if (raw.startsWith("diff --git") || raw.startsWith("index ") || raw.startsWith("---") || raw.startsWith("+++") || raw.startsWith("@@")) {
        kind = "meta";
      } else if (raw.startsWith("+")) {
        kind = "added";
        line = raw.slice(1);
      } else if (raw.startsWith("-")) {
        kind = "removed";
        line = raw.slice(1);
      } else {
        kind = "context";
        line = raw.startsWith(" ") ? raw.slice(1) : raw;
      }
      return { key: `${i}-${raw}`, line, kind };
    });
  }, [text]);

  return (
    <div style={CONTAINER_STYLE}>
      {rows.map(({ key, line, kind }) => (
        <DiffLine key={key} id={key} line={line} kind={kind} />
      ))}
    </div>
  );
}
