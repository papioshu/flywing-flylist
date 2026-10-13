import { describe, expect, it } from "vitest";
import { csvCell, toCsv } from "../supabase/functions/_shared/csv.ts";
import { parseTwitterHandle } from "../supabase/functions/_shared/twitter.ts";
import { parseCsv } from "./helpers.ts";

describe("X username validation", () => {
  it("accepts handles with and without @, keeping display case and normalizing", () => {
    expect(parseTwitterHandle("@FlyWing_Genesis")).toEqual({
      ok: true,
      handle: { display: "FlyWing_Genesis", normalized: "flywing_genesis" },
    });
    expect(parseTwitterHandle("  jack ")).toEqual({ ok: true, handle: { display: "jack", normalized: "jack" } });
    expect(parseTwitterHandle("a")).toMatchObject({ ok: true });
    expect(parseTwitterHandle("abcdefghijklmno")).toMatchObject({ ok: true }); // exactly 15
  });

  it("rejects empty, too long, bad characters, and non-strings", () => {
    for (const bad of ["", "@", "   ", "abcdefghijklmnop", "has space", "dash-name", "dot.name", "@@double", "émoji", "<script>", 42, null, undefined]) {
      expect(parseTwitterHandle(bad as never).ok, String(bad)).toBe(false);
    }
  });
});

describe("CSV encoding", () => {
  it("quotes and escapes commas, quotes and newlines", () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("line1\nline2")).toBe('"line1\nline2"');
    expect(csvCell(null)).toBe("");
    expect(csvCell(42)).toBe('"42"');
  });

  it("neutralizes spreadsheet formula injection", () => {
    for (const evil of ["=1+1", "+1", "-1", "@SUM(A1)", "\t=x", "\r=x", "＝1+1", '=HYPERLINK("http://evil","x")']) {
      expect(csvCell(evil).startsWith(`"'`), evil).toBe(true);
    }
    expect(csvCell("safe=value")).toBe('"safe=value"');
  });

  it("produces a BOM, header row and CRLF rows that round-trip", () => {
    const csv = toCsv(["a", "b"], [["x,1", 'q"2'], ["multi\nline", "=bad"]]);
    expect(csv.startsWith("﻿")).toBe(true);
    expect(parseCsv(csv.slice(1))).toEqual([
      ["a", "b"],
      ["x,1", 'q"2'],
      ["multi\nline", "'=bad"],
    ]);
  });
});
