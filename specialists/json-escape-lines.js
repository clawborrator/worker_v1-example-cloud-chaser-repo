#!/usr/bin/env node
// Reads lines from stdin, writes each as a JSON-string-encoded
// value followed by a trailing comma. Skips empty lines.
//
// Used by collect.sh wherever it pipes shell-captured strings
// (container logs, kernel errors) into JSON arrays. Doing the
// JSON-string escaping in awk is fragile because awk's gsub
// replacement string semantics interact unpredictably with awk's
// own string-literal backslash escaping. Node's JSON.stringify
// is the correct, unambiguous primitive.
//
// Usage in collect.sh:
//   echo $LINES | node specialists/json-escape-lines.js | sed 's/,$//'
//   # produces: "line1","line2","line3"

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => { buf += d; });
process.stdin.on('end', () => {
  for (const line of buf.split('\n')) {
    if (line.length === 0) continue;
    process.stdout.write(JSON.stringify(line) + ',');
  }
});
