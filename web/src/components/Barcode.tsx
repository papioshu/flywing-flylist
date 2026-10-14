// Boarding-pass barcode for the modal stub: a real Code 39 encoding of `value`, drawn vertically
// (bars run across the stub, stacked top to bottom). Decorative; the dialog is labelled elsewhere.

// Code 39: 9 elements per character (bar, space, bar, ...), "1" = wide. Only the characters we use.
const CODE39: Record<string, string> = {
  "*": "010010100",
  A: "100001001", B: "001001001", C: "101001000", D: "000011001", E: "100011000", F: "001011000",
  G: "000001101", H: "100001100", I: "001001100", J: "000011100", K: "100000011", L: "001000011",
  M: "101000010", N: "000010011", O: "100010010", P: "001010010", Q: "000000111", R: "100000110",
  S: "001000110", T: "000010110", U: "110000001", V: "011000001", W: "111000000", X: "010010001",
  Y: "110010000", Z: "011010000",
};
const NARROW = 1;
const WIDE = 3;

function bars(value: string) {
  const out: { y: number; h: number }[] = [];
  let y = 0;
  for (const ch of `*${value.toUpperCase()}*`) {
    const pattern = CODE39[ch];
    if (!pattern) continue;
    [...pattern].forEach((bit, i) => {
      const h = bit === "1" ? WIDE : NARROW;
      if (i % 2 === 0) out.push({ y, h }); // even positions are bars
      y += h;
    });
    y += NARROW; // inter-character gap
  }
  return { out, total: y - NARROW };
}

export function Barcode({ value, className }: { value: string; className?: string }) {
  const { out, total } = bars(value);
  return (
    <svg className={className} viewBox={`0 0 10 ${total}`} preserveAspectRatio="none" aria-hidden focusable="false">
      {out.map((b, i) => (
        <rect key={i} x="0" y={b.y} width="10" height={b.h} fill="currentColor" />
      ))}
    </svg>
  );
}
