// Fast drop-in replacement for csv-reader 1.0.0.
//
// Written from scratch from the competition brief (RULES.txt) and the
// practice input/expected data. Single left-to-right pass over the text.
// Delimiters are located with indexOf and fields are sliced out, so the
// common paths build no intermediate strings and no per-field objects.
//
// Semantics (from the brief):
// - A U+FEFF at the very start is dropped.
// - A record ends at LF or CRLF; a line left with no characters is no record.
// - Outside quotes a CR not followed by LF is dropped (error stray_cr).
// - A field opening with a quote runs to the next quote that is not doubled;
//   "" inside it is one quote, and each CRLF or lone CR inside it is read
//   as LF. What follows the closing quote, up to the next comma or line
//   break, is appended as it stands (error quote_junk, when the field ends).
// - A quote that never closes is a literal character and the text after it
//   is read again as unquoted (error unterminated_quote).
// - A quote inside an unquoted field is a literal character.
// - Fields stay strings, never trimmed or converted.
// - columns is the first record when header is true, else null; rows are
//   the records after it (every record when header is false), each padded
//   with empty strings (short_row, with fields: its field count) or cut
//   (long_row, with extra: the cut fields) to the first record's width.
// - Each error is {code, line, row}, in the order met, with line the
//   1-based line its record starts on. A record's short_row/long_row is
//   recorded when the record ends. The line counter advances on every LF,
//   CRLF and lone CR inside quotes; a stray CR outside quotes does not
//   advance it. (A stray CR met between records, where no record has
//   started yet, is reported on the line it sits on.)
// - row is the record's index in rows, null for the header record.

const COMMA = 44; // ,
const QUOTE = 34; // "
const LF = 10; // \n
const CR = 13; // \r
const BOM = 0xfeff;

// Field-end kinds.
const K_COMMA = 0;
const K_LF = 1;
const K_CRLF = 2;
const K_EOF = 3;

export function run(input) {
  const text = input.text;
  const header = input.header;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;
  let line = 1;
  let i = 0;
  if (n > 0 && text.charCodeAt(0) === BOM) i = 1;
  let first = true;
  let recRow = null;
  let recStart = 1;

  // Shared scratch for the field parsers below (avoids one allocation
  // per field): value/kind/i describe the parsed field, close/doubled
  // describe the closing quote found by findClose.
  const out = { value: '', kind: K_EOF, i: 0, close: -1, doubled: false };

  // Earliest of ',', '\n', '\r' at or after `from`, or n when none.
  // One regex scan instead of three indexOf scans: the '\r' indexOf could
  // run far past the field in LF files, while the regex stops at the first
  // delimiter of any kind. The regex is reset (lastIndex) on every call,
  // and run() is synchronous, so the shared state is safe.
  const DELIM_RE = /[,\n\r]/g;
  function nextDelim(from) {
    DELIM_RE.lastIndex = from;
    const m = DELIM_RE.exec(text);
    return m === null ? n : m.index;
  }

  // Parse an unquoted field starting at `from`. Stray CRs are dropped
  // (each reported) and the field continues after them.
  function parseUnquoted(from) {
    let start = from;
    let pos = from;
    let parts = null;
    for (;;) {
      const m = nextDelim(pos);
      if (m >= n) {
        out.value =
          parts === null ? text.slice(start, n) : (parts.push(text.slice(start, n)), parts.join(''));
        out.kind = K_EOF;
        out.i = n;
        return;
      }
      const code = text.charCodeAt(m);
      if (code === COMMA) {
        out.value =
          parts === null ? text.slice(start, m) : (parts.push(text.slice(start, m)), parts.join(''));
        out.kind = K_COMMA;
        out.i = m + 1;
        return;
      }
      if (code === LF) {
        out.value =
          parts === null ? text.slice(start, m) : (parts.push(text.slice(start, m)), parts.join(''));
        out.kind = K_LF;
        out.i = m + 1;
        line++;
        return;
      }
      // CR.
      if (m + 1 < n && text.charCodeAt(m + 1) === LF) {
        out.value =
          parts === null ? text.slice(start, m) : (parts.push(text.slice(start, m)), parts.join(''));
        out.kind = K_CRLF;
        out.i = m + 2;
        line++;
        return;
      }
            errors.push({ code: 'stray_cr', line: recStart, row: recRow });
      if (parts === null) parts = [text.slice(start, m)];
      else parts.push(text.slice(start, m));
      pos = m + 1;
      start = m + 1;
    }
  }

  // Locate the closing quote of a field opening at `from` (text[from] is
  // '"'). Sets out.close to its index, or -1 when the quote never closes,
  // and out.doubled when a "" pair was skipped on the way.
  function findClose(from) {
    let j = text.indexOf('"', from + 1);
    let doubled = false;
    while (j !== -1) {
      if (text.charCodeAt(j + 1) !== QUOTE) {
        out.close = j;
        out.doubled = doubled;
        return;
      }
      doubled = true;
      j = text.indexOf('"', j + 2);
    }
    out.close = -1;
    out.doubled = doubled;
  }

  // Parse a quoted field opening at `from`, closing at `close`.
  // Handles the text after the closing quote (junk / delimiter).
  function parseQuoted(from, close) {
    let value;
    const crInRegion = text.indexOf('\r', from + 1);
    if (!out.doubled && (crInRegion === -1 || crInRegion >= close)) {
      // No doubled quotes and no CR in the quoted region: the value is
      // one slice. Only LF line breaks inside it need counting.
      value = text.slice(from + 1, close);
      let p = text.indexOf('\n', from + 1);
      if (p !== -1 && p < close) {
        let cnt = 0;
        while (p !== -1 && p < close) {
          cnt++;
          p = text.indexOf('\n', p + 1);
        }
        line += cnt;
      }
    } else {
      // Slow path: doubled quotes and/or CR/LF inside the quoted region.
      // Walk it once, folding "" to " and every CRLF / lone CR / LF to
      // a single LF while counting line breaks.
      const parts = [];
      let seg = from + 1;
      let p = from + 1;
      while (p < close) {
        const ch = text.charCodeAt(p);
        if (ch === QUOTE) {
          parts.push(text.slice(seg, p), '"');
          p += 2;
          seg = p;
        } else if (ch === CR) {
          parts.push(text.slice(seg, p), '\n');
          line++;
          p += p + 1 < close && text.charCodeAt(p + 1) === LF ? 2 : 1;
          seg = p;
        } else if (ch === LF) {
          parts.push(text.slice(seg, p), '\n');
          line++;
          p++;
          seg = p;
        } else {
          p++;
        }
      }
      parts.push(text.slice(seg, close));
      value = parts.join('');
    }

    // What follows the closing quote, up to the next comma or line break,
    // is appended as it stands (quote_junk when the field ends).
    let k = close + 1;
    if (k >= n) {
      out.value = value;
      out.kind = K_EOF;
      out.i = n;
      return;
    }
    let code = text.charCodeAt(k);
    if (code === COMMA) {
      out.value = value;
      out.kind = K_COMMA;
      out.i = k + 1;
      return;
    }
    if (code === LF) {
      out.value = value;
      out.kind = K_LF;
      out.i = k + 1;
      line++;
      return;
    }
    if (code === CR) {
      if (k + 1 < n && text.charCodeAt(k + 1) === LF) {
        out.value = value;
        out.kind = K_CRLF;
        out.i = k + 2;
        line++;
        return;
      }
      // Lone CR right after the closing quote: dropped, reported, and
      // the junk scan continues after it.
      errors.push({ code: 'stray_cr', line: recStart, row: recRow });
      k++;
    }
    // Junk scan.
    let jstart = k;
    let jpos = k;
    let parts = null;
    for (;;) {
      const m = nextDelim(jpos);
      if (m >= n) {
        const junk =
          parts === null ? text.slice(jstart, n) : (parts.push(text.slice(jstart, n)), parts.join(''));
        if (junk.length > 0) errors.push({ code: 'quote_junk', line: recStart, row: recRow });
        out.value = junk.length > 0 ? value + junk : value;
        out.kind = K_EOF;
        out.i = n;
        return;
      }
      const mc = text.charCodeAt(m);
      if (mc === COMMA) {
        const junk =
          parts === null ? text.slice(jstart, m) : (parts.push(text.slice(jstart, m)), parts.join(''));
        if (junk.length > 0) errors.push({ code: 'quote_junk', line: recStart, row: recRow });
        out.value = junk.length > 0 ? value + junk : value;
        out.kind = K_COMMA;
        out.i = m + 1;
        return;
      }
      if (mc === LF) {
        const junk =
          parts === null ? text.slice(jstart, m) : (parts.push(text.slice(jstart, m)), parts.join(''));
        if (junk.length > 0) errors.push({ code: 'quote_junk', line: recStart, row: recRow });
        out.value = junk.length > 0 ? value + junk : value;
        out.kind = K_LF;
        out.i = m + 1;
        line++;
        return;
      }
      // CR.
      if (m + 1 < n && text.charCodeAt(m + 1) === LF) {
        const junk =
          parts === null ? text.slice(jstart, m) : (parts.push(text.slice(jstart, m)), parts.join(''));
        if (junk.length > 0) errors.push({ code: 'quote_junk', line: recStart, row: recRow });
        out.value = junk.length > 0 ? value + junk : value;
        out.kind = K_CRLF;
        out.i = m + 2;
        line++;
        return;
      }
      errors.push({ code: 'stray_cr', line: recStart, row: recRow });
      if (parts === null) parts = [text.slice(jstart, m)];
      else parts.push(text.slice(jstart, m));
      jpos = m + 1;
      jstart = m + 1;
    }
  }

  while (i < n) {
    let recordStartLine = line;
    recRow = header && first ? null : rows.length;
    // Skip empty lines and stray CRs before the record starts. A stray
    // CR is not a line break, so the record still starts on this line.
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === LF) {
        i++;
        line++;
        recordStartLine = line;
      } else if (c === CR) {
        if (i + 1 < n && text.charCodeAt(i + 1) === LF) {
          i += 2;
          line++;
          recordStartLine = line;
        } else {
          errors.push({ code: 'stray_cr', line, row: recRow });
          i++;
        }
      } else {
        break;
      }
    }
    if (i >= n) break;
    recStart = recordStartLine;

    const fields = [];
    let done = false;
    while (!done) {
      if (i < n && text.charCodeAt(i) === QUOTE) {
        findClose(i);
        if (out.close === -1) {
          // A quote that never closes is a literal character; the text
          // after it is read again as unquoted.
          errors.push({ code: 'unterminated_quote', line: recStart, row: recRow });
          parseUnquoted(i);
        } else {
          parseQuoted(i, out.close);
        }
      } else {
        parseUnquoted(i);
      }
      fields.push(out.value);
      i = out.i;
      if (out.kind === K_COMMA) continue;
      done = true;
    }

    if (first) {
      width = fields.length;
      if (header) columns = fields;
      else rows.push(fields);
      first = false;
    } else if (fields.length < width) {
      const count = fields.length;
      for (let p = count; p < width; p++) fields.push('');
      errors.push({ code: 'short_row', line: recordStartLine, row: recRow, fields: count });
      rows.push(fields);
    } else if (fields.length > width) {
      const extra = fields.slice(width);
      fields.length = width;
      errors.push({ code: 'long_row', line: recordStartLine, row: recRow, extra });
      rows.push(fields);
    } else {
      rows.push(fields);
    }
  }

  return { columns, rows, errors };
}
