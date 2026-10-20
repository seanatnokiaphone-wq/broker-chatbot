/** Pretty-printed, syntax-coloured JSON. Falls back to the raw text if it doesn't parse. */
export function JsonView({ text }: { text: string }) {
  let pretty: string;
  try {
    pretty = JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return <pre className="json-view">{text}</pre>;
  }
  const parts: React.ReactNode[] = [];
  const re = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(pretty))) {
    if (m.index > last) parts.push(pretty.slice(last, m.index));
    const cls = m[1] ? (m[2] ? "j-key" : "j-str") : m[3] ? "j-lit" : "j-num";
    parts.push(
      <span key={m.index} className={cls}>
        {m[1] ?? m[0]}
      </span>,
    );
    if (m[2]) parts.push(m[2]);
    last = re.lastIndex;
  }
  parts.push(pretty.slice(last));
  return <pre className="json-view">{parts}</pre>;
}
