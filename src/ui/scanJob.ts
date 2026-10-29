/**
 * "Segment on Nebius": an uploaded CT with no labels goes to the backend
 * (/api/scans), which starts a vista3d-full Serverless Job. The dialog shows
 * the job's real stages (UPLOADED -> SEGMENTING -> CENTERLINE -> READY), each
 * with its measured time, then opens the planned case.
 */

import { apiUrl } from '../ai/agentClient.ts';

export type ScanStage = 'UPLOADING' | 'UPLOADED' | 'SEGMENTING' | 'CENTERLINE' | 'READY' | 'FAILED';

export interface ScanStatus {
  id: string;
  stage: ScanStage;
  elapsed_s?: number;
  job_state?: string | null;
  stages?: Record<string, number>;
  gpu?: string;
  error?: string;
}

const STEPS: { stage: ScanStage; label: string }[] = [
  { stage: 'UPLOADING', label: 'Upload to Nebius' },
  { stage: 'UPLOADED', label: 'Uploaded, starting an H100 job' },
  { stage: 'SEGMENTING', label: 'Segmenting with VISTA-3D' },
  { stage: 'CENTERLINE', label: 'Labels, meshes, aorta centerline' },
  { stage: 'READY', label: 'Ready' },
];
const POLL_MS = 3000;

/** POST the file with upload progress (fetch has none). */
function postFile(url: string, file: File, onProgress: (f: number) => void): Promise<ScanStatus> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.setRequestHeader('content-type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      let body: { detail?: string } & Partial<ScanStatus> = {};
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        /* not JSON */
      }
      if (xhr.status === 200 && body.id) resolve(body as ScanStatus);
      else reject(new Error(body.detail ? `Upload refused: ${body.detail}.` : `Upload failed (${xhr.status}).`));
    };
    xhr.onerror = () => reject(new Error('Upload failed: the scan service did not answer.'));
    xhr.send(file);
  });
}

export class ScanJobDialog {
  private root = document.createElement('div');
  private text = document.createElement('div');
  private steps = document.createElement('ol');
  private status = document.createElement('div');
  private go = document.createElement('button');
  private cancel = document.createElement('button');
  private file: File | null = null;
  private running = false;
  private stepEls = new Map<ScanStage, { row: HTMLLIElement; time: HTMLSpanElement }>();

  constructor(private readonly openCase: (id: string) => Promise<void>, private readonly say: (s: string) => void) {
    this.root.className = 'palette scanjob';
    this.root.hidden = true;
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-label', 'Segment on Nebius');
    const card = document.createElement('div');
    card.className = 'palette-card';
    const title = document.createElement('div');
    title.className = 'gallery-title';
    title.textContent = 'Segment this scan on Nebius';
    this.text.className = 'palette-label scanjob-text';
    this.text.textContent =
      'VISTA-3D on a Nebius H100 labels the liver, tumour, vessels and aorta, then the planned case opens. ' +
      'The CT goes to the Scrub+ Nebius bucket, never to a closed model. Research use only.';
    this.steps.className = 'scanjob-steps';
    for (const s of STEPS) {
      const row = document.createElement('li');
      const label = document.createElement('span');
      label.textContent = s.label;
      const time = document.createElement('span');
      time.className = 'scanjob-time';
      row.append(label, time);
      this.steps.append(row);
      this.stepEls.set(s.stage, { row, time });
    }
    this.status.className = 'palette-status';
    this.status.setAttribute('aria-live', 'polite');
    const foot = document.createElement('div');
    foot.className = 'scanjob-actions';
    this.go.type = 'button';
    this.go.className = 'scanjob-go';
    this.go.textContent = 'Segment on Nebius';
    this.go.addEventListener('click', () => void this.run());
    this.cancel.type = 'button';
    this.cancel.textContent = 'Not now';
    this.cancel.addEventListener('click', () => this.close());
    foot.append(this.go, this.cancel);
    card.append(title, this.text, this.steps, this.status, foot);
    this.root.append(card);
    this.root.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.close();
      }
    });
    document.body.append(this.root);
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  /** Offer to segment `file`; nothing is sent until the user says so. */
  offer(file: File): void {
    if (this.running) {
      this.root.hidden = false;
      return;
    }
    this.file = file;
    this.mark(null);
    this.status.textContent = `${file.name}, ${(file.size / 1e6).toFixed(0)} MB`;
    this.go.hidden = false;
    this.go.disabled = false;
    this.cancel.textContent = 'Not now';
    this.root.hidden = false;
    this.go.focus();
  }

  /** Hide the dialog; a running job keeps going and still opens when ready. */
  close(): void {
    this.root.hidden = true;
  }

  private mark(stage: ScanStage | null, s?: ScanStatus): void {
    const at = stage ? STEPS.findIndex((x) => x.stage === stage) : -1;
    STEPS.forEach((x, i) => {
      const el = this.stepEls.get(x.stage)!;
      el.row.className = i < at || stage === 'READY' ? 'done' : i === at ? 'now' : '';
    });
    const t = s?.stages ?? {};
    if (t.segmenting !== undefined) this.stepEls.get('SEGMENTING')!.time.textContent = `${t.segmenting.toFixed(1)} s`;
    if (t.centerline !== undefined) this.stepEls.get('CENTERLINE')!.time.textContent = `${t.centerline.toFixed(1)} s`;
    if (stage === null) for (const el of this.stepEls.values()) el.time.textContent = '';
  }

  private async run(): Promise<void> {
    if (!this.file || this.running) return;
    this.running = true;
    this.go.hidden = true;
    this.cancel.textContent = 'Hide';
    this.root.classList.add('busy');
    const t0 = performance.now();
    try {
      this.mark('UPLOADING');
      const up = await postFile(apiUrl('scans'), this.file, (f) => {
        this.stepEls.get('UPLOADING')!.time.textContent = `${Math.round(f * 100)} %`;
      });
      this.stepEls.get('UPLOADING')!.time.textContent = `${((performance.now() - t0) / 1000).toFixed(1)} s`;
      let s: ScanStatus = up;
      for (;;) {
        this.mark(s.stage, s);
        const wall = Math.round((performance.now() - t0) / 1000);
        this.status.textContent = `${s.stage}${s.job_state ? ` · job ${s.job_state.toLowerCase().replace(/_/g, ' ')}` : ''} · ${wall} s`;
        if (s.stage === 'READY' || s.stage === 'FAILED') break;
        await new Promise((r) => setTimeout(r, POLL_MS));
        const res = await fetch(`${apiUrl('scans')}/${up.id}`);
        if (res.ok) s = (await res.json()) as ScanStatus;
      }
      if (s.stage === 'FAILED') throw new Error(`Segmentation failed: ${s.error ?? 'job failed'}.`);
      const wall = Math.round((performance.now() - t0) / 1000);
      this.status.textContent = `READY · ${wall} s from upload · ${s.gpu ?? 'H100'}`;
      await this.openCase(up.id);
      this.close();
      const seg = s.stages?.segmenting;
      this.say(`Scan segmented on Nebius${seg !== undefined ? `: VISTA-3D took ${seg.toFixed(1)} seconds` : ''}. Planning is on.`);
    } catch (err) {
      console.warn('[scans]', err);
      this.status.textContent = err instanceof Error ? err.message : 'Segmentation failed.';
      this.mark(null);
      this.go.hidden = false;
      this.go.textContent = 'Try again';
      this.cancel.textContent = 'Close';
    } finally {
      this.running = false;
      this.root.classList.remove('busy');
    }
  }
}
