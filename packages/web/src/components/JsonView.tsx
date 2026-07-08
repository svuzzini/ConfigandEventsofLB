import { useMemo } from 'react';

/** Read-only syntax-highlighted JSON. */
export function JsonView({ value }: { value: unknown }) {
  const html = useMemo(() => highlight(value), [value]);
  return <pre className="json" dangerouslySetInnerHTML={{ __html: html }} />;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function highlight(value: unknown): string {
  const json = esc(JSON.stringify(value, null, 2) ?? 'null');
  const re =
    /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false)\b|\bnull\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g;
  return json.replace(re, (match) => {
    let cls = 'tok-num';
    if (/^"/.test(match)) cls = /:$/.test(match) ? 'tok-key' : 'tok-str';
    else if (/^(true|false)$/.test(match)) cls = 'tok-bool';
    else if (match === 'null') cls = 'tok-null';
    return `<span class="${cls}">${match}</span>`;
  });
}
