import { useCallback, useRef, useState } from 'react';
import type { IngestResult } from '@avi/shared';
import { api } from '../api/client.js';

/**
 * Streams the selected file to the server as the raw request body. The browser
 * never parses the dump, so a 200 MB file costs only upload bandwidth, not heap.
 */
export function UploadPanel({ onIngested }: { onIngested: (r: IngestResult) => void }) {
  const [drag, setDrag] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const handle = useCallback(
    async (file: File | undefined) => {
      if (!file) return;
      setBusy(true);
      setError(null);
      try {
        const result = await api.ingest(file);
        onIngested(result);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [onIngested],
  );

  return (
    <div className="card">
      <div
        className={`dropzone${drag ? ' drag' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          void handle(e.dataTransfer.files[0]);
        }}
        onClick={() => inputRef.current?.click()}
      >
        {busy ? (
          <div>Parsing on the server… this streams, so large dumps are fine.</div>
        ) : (
          <div>
            <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 6 }}>
              Drop an avi_config JSON here
            </div>
            <div>or click to choose a file — parsed server-side, never loaded into the browser</div>
          </div>
        )}
        <input
          ref={inputRef}
          type="file"
          accept=".json,application/json"
          style={{ display: 'none' }}
          onChange={(e) => void handle(e.target.files?.[0] ?? undefined)}
        />
      </div>
      {error && <div className="error" style={{ marginTop: 12 }}>{error}</div>}
    </div>
  );
}
