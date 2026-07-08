/**
 * Streaming parser for an Avi config dump.
 *
 * The dump is one large JSON object: `{ "VirtualService": [ {...}, ... ],
 * "Pool": [...], "META": {...} }`. We must NOT call JSON.parse on the whole
 * file — a 200 MB dump would balloon to multiple GB of resident JS objects.
 *
 * Strategy: tokenize with stream-json and run a small state machine that keeps
 * at most ONE fully-assembled object in memory at a time:
 *   - depth 1 keys are object-type names,
 *   - when a key's value is an array, each element is assembled individually and
 *     handed to `onObject(type, obj)` then released,
 *   - any non-array top-level value (e.g. "META") is assembled and handed to
 *     `onMeta(key, value)`.
 *
 * Peak heap is therefore O(largest single object), not O(file). Backpressure is
 * preserved because we consume the parser as an async iterable.
 */
import { createReadStream } from 'node:fs';
import Parser from 'stream-json/Parser.js';
import Assembler from 'stream-json/Assembler.js';

export interface StreamHandlers {
  /** Called once per array element under a top-level type key. */
  onObject: (type: string, obj: unknown) => void | Promise<void>;
  /** Called once per non-array top-level key (META, version blocks, …). */
  onMeta?: (key: string, value: unknown) => void;
}

interface TokenLike {
  readonly name: string;
  readonly value?: string;
}

/**
 * Parse `filePath`, invoking handlers as objects stream in. Resolves when the
 * whole file has been consumed. Rejects on malformed JSON or I/O error.
 */
export async function streamAviConfig(filePath: string, handlers: StreamHandlers): Promise<void> {
  const tokenStream = createReadStream(filePath).pipe(
    new Parser({ packKeys: true, packStrings: true, packNumbers: true, streamValues: false }),
  );

  // Top-level state.
  let rootOpened = false;
  let pendingKey: string | null = null; // most recent depth-1 key awaiting its value
  let inArray = false; // currently iterating the array for `pendingKey`
  let arrayType: string | null = null; // type name for the array being iterated

  // Element assembler state (reused; one element at a time).
  let asm: Assembler | null = null;
  let assembling = false;

  const beginAssembly = (): void => {
    asm = new Assembler();
    assembling = true;
  };

  const feed = (tok: TokenLike): void => {
    const a = asm as unknown as Record<string, (v?: string) => void> & { done: boolean; current: unknown };
    const fn = a[tok.name];
    if (typeof fn === 'function') fn.call(a, tok.value);
  };

  for await (const raw of tokenStream as AsyncIterable<TokenLike>) {
    const tok = raw;

    // --- Mid-assembly: route every token to the element assembler. ---
    if (assembling) {
      feed(tok);
      const a = asm as unknown as { done: boolean; current: unknown };
      if (a.done) {
        const value = a.current;
        assembling = false;
        asm = null;
        if (inArray && arrayType !== null) {
          await handlers.onObject(arrayType, value);
        } else if (pendingKey !== null) {
          handlers.onMeta?.(pendingKey, value);
          pendingKey = null;
        }
      }
      continue;
    }

    // --- Not assembling: interpret structural tokens at the top / array level. ---
    switch (tok.name) {
      case 'startObject': {
        if (!rootOpened) {
          rootOpened = true; // the document root object
        } else if (inArray) {
          // Start of an object element inside an array.
          beginAssembly();
          feed(tok);
        } else if (pendingKey !== null) {
          // A top-level value that is an object (e.g. META).
          beginAssembly();
          feed(tok);
        }
        break;
      }
      case 'startArray': {
        if (pendingKey !== null && !inArray) {
          // Enter the array for the current type key.
          inArray = true;
          arrayType = pendingKey;
        } else if (inArray) {
          // An array element that is itself an array — assemble it whole.
          beginAssembly();
          feed(tok);
        }
        break;
      }
      case 'endArray': {
        if (inArray) {
          inArray = false;
          arrayType = null;
          pendingKey = null;
        }
        break;
      }
      case 'keyValue': {
        // A key. At depth 1 (root, not in array) it names a type / meta block.
        if (rootOpened && !inArray) pendingKey = tok.value ?? null;
        break;
      }
      case 'stringValue':
      case 'numberValue':
      case 'nullValue':
      case 'trueValue':
      case 'falseValue': {
        // A scalar sitting directly where a value is expected.
        if (inArray && arrayType !== null) {
          // Scalar array element — assemble (completes immediately) then emit.
          beginAssembly();
          feed(tok);
          const a = asm as unknown as { done: boolean; current: unknown };
          if (a.done) {
            await handlers.onObject(arrayType, a.current);
            assembling = false;
            asm = null;
          }
        } else if (pendingKey !== null) {
          // Top-level scalar value (rare) — treat as meta.
          beginAssembly();
          feed(tok);
          const a = asm as unknown as { done: boolean; current: unknown };
          if (a.done) {
            handlers.onMeta?.(pendingKey, a.current);
            pendingKey = null;
            assembling = false;
            asm = null;
          }
        }
        break;
      }
      case 'endObject':
      default:
        // Root endObject or ignorable structural token.
        break;
    }
  }
}
