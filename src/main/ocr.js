// OWNER: Agent A. Text recognition service for explicit-text protection (macOS: Vision framework helper).
// Pixels arrive from the overlay as 8-bit grayscale, go to the helper over a pipe and are dropped after the
// check: memory only, never written to disk, never logged. Recognized text is returned, never logged.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

/** where the helper lives: packaged app -> resources/ocr, dev -> vendor/ocr (built by npm run content:setup) */
export function ocrHelperPath(srcDir) {
  const candidates = [
    app.isPackaged ? path.join(process.resourcesPath, 'ocr', 'shield-ocr') : null,
    path.join(srcDir, '..', 'vendor', 'ocr', 'shield-ocr'),
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

/**
 * @param {string|null} helper  path to shield-ocr, or null (not available: every request returns no lines)
 * @param {{ level?: 'fast'|'accurate' }} [opts]
 */
export function createOcr(helper, { level = 'accurate' } = {}) {
  if (!helper || process.platform !== 'darwin') return { available: false, recognize: async () => ({ lines: [], ms: 0 }), stop() {} };
  let proc = null;
  let nextId = 1;
  let buf = '';
  /** @type {Map<number, (r: any) => void>} */
  const waiting = new Map();

  function start() {
    proc = spawn(helper, [level], { stdio: ['pipe', 'pipe', 'ignore'] });
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        try {
          const r = JSON.parse(line);
          waiting.get(r.id)?.(r);
          waiting.delete(r.id);
        } catch {}
      }
    });
    proc.on('exit', () => {
      proc = null;
      for (const done of waiting.values()) done({ lines: [], ms: 0 });
      waiting.clear();
    });
    proc.stdin.on('error', () => {});
  }

  return {
    available: true,
    /**
     * @param {{ width: number, height: number, gray: Uint8Array }} frame
     * @returns {Promise<{ lines: {t:string,x:number,y:number,w:number,h:number,c:number}[], ms: number }>}
     */
    recognize({ width, height, gray }) {
      if (!proc) start();
      const id = nextId++;
      const header = Buffer.alloc(12);
      header.writeUInt32LE(width, 0);
      header.writeUInt32LE(height, 4);
      header.writeUInt32LE(id, 8);
      return new Promise((resolve) => {
        waiting.set(id, resolve);
        proc.stdin.write(header);
        proc.stdin.write(Buffer.from(gray.buffer, gray.byteOffset, gray.byteLength));
        setTimeout(() => waiting.has(id) && (waiting.delete(id), resolve({ lines: [], ms: 0 })), 15000);
      });
    },
    stop() {
      proc?.kill();
      proc = null;
    },
  };
}
