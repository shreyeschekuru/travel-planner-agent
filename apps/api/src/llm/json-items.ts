/**
 * Incrementally extracts complete objects from the first array inside a top-level
 * JSON object, e.g. {"items":[{...},{...}]}, as text streams in. Each completed
 * element is returned as soon as its closing brace arrives.
 */
export class JsonArrayItemSplitter {
  private buf = "";
  private pos = 0;
  private stack: ("{" | "[")[] = [];
  private inString = false;
  private escape = false;
  private itemStart = -1;
  private arrayDone = false;

  push(chunk: string): unknown[] {
    this.buf += chunk;
    const out: unknown[] = [];
    for (; this.pos < this.buf.length; this.pos++) {
      const c = this.buf[this.pos]!;
      if (this.inString) {
        if (this.escape) this.escape = false;
        else if (c === "\\") this.escape = true;
        else if (c === '"') this.inString = false;
        continue;
      }
      if (c === '"') {
        this.inString = true;
      } else if (c === "{" || c === "[") {
        this.stack.push(c);
        const inItemsArray =
          !this.arrayDone &&
          this.stack.length === 3 &&
          this.stack[0] === "{" &&
          this.stack[1] === "[";
        if (inItemsArray && c === "{") this.itemStart = this.pos;
      } else if (c === "}" || c === "]") {
        this.stack.pop();
        if (c === "}" && this.stack.length === 2 && this.itemStart >= 0) {
          const raw = this.buf.slice(this.itemStart, this.pos + 1);
          this.itemStart = -1;
          try {
            out.push(JSON.parse(raw));
          } catch {
            // Incomplete or invalid element: skip it; the final parse is authoritative.
          }
        }
        if (c === "]" && this.stack.length === 1) this.arrayDone = true;
      }
    }
    return out;
  }
}
