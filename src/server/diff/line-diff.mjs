export function buildLineDiff(fromMarkdown, toMarkdown) {
  const fromLines = String(fromMarkdown || "").split("\n");
  const toLines = String(toMarkdown || "").split("\n");
  const table = buildLcsTable(fromLines, toLines);
  const rows = [];
  let i = 0;
  let j = 0;

  while (i < fromLines.length || j < toLines.length) {
    if (i < fromLines.length && j < toLines.length && fromLines[i] === toLines[j]) {
      rows.push({ type: "context", text: fromLines[i], oldLine: i + 1, newLine: j + 1 });
      i += 1;
      j += 1;
      continue;
    }

    if (j < toLines.length && (i === fromLines.length || table[i][j + 1] >= table[i + 1][j])) {
      rows.push({ type: "add", text: toLines[j], oldLine: null, newLine: j + 1 });
      j += 1;
      continue;
    }

    if (i < fromLines.length) {
      rows.push({ type: "remove", text: fromLines[i], oldLine: i + 1, newLine: null });
      i += 1;
    }
  }

  return {
    rows,
    changedRanges: collectChangedRanges(rows),
  };
}

function buildLcsTable(a, b) {
  const table = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  return table;
}

function collectChangedRanges(rows) {
  const ranges = [];
  let current = null;

  for (const row of rows) {
    if (row.type === "context") {
      if (current) {
        ranges.push(closeRange(current));
        current = null;
      }
      continue;
    }

    if (!current) {
      current = {
        oldStart: row.oldLine,
        oldEnd: row.oldLine,
        newStart: row.newLine,
        newEnd: row.newLine,
      };
    } else {
      if (row.oldLine != null) current.oldEnd = row.oldLine;
      if (row.newLine != null) current.newEnd = row.newLine;
      if (current.oldStart == null && row.oldLine != null) current.oldStart = row.oldLine;
      if (current.newStart == null && row.newLine != null) current.newStart = row.newLine;
    }
  }

  if (current) ranges.push(closeRange(current));
  return ranges;
}

function closeRange(range) {
  return {
    oldStart: range.oldStart,
    oldEnd: range.oldEnd ?? range.oldStart,
    newStart: range.newStart,
    newEnd: range.newEnd ?? range.newStart,
  };
}


