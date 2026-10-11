/**
 * "Upload a CT": a file picker (and drag-and-drop anywhere on the page) for
 * one NIfTI CT, optionally with a label map. Which file is which is decided
 * from the voxels, not the file name: a label map holds a few small whole
 * numbers; a CT does not.
 *
 * Everything stays in the browser; nothing is uploaded to a server.
 */

import { readNifti, type NiftiImage } from './nifti.ts';
import { caseFromNifti } from './volumeCase.ts';
import type { CaseData } from '../types.ts';

/** True when the volume looks like a label map (few small whole numbers). */
export function looksLikeLabels(img: NiftiImage): boolean {
  const seen = new Set<number>();
  const step = Math.max(1, Math.floor(img.data.length / 2_000_000));
  for (let i = 0; i < img.data.length; i += step) {
    const v = img.data[i];
    if (v < 0 || v > 255 || v !== Math.round(v)) return false;
    seen.add(v);
    if (seen.size > 64) return false;
  }
  return seen.size >= 2;
}

/** Read the files and build the case; throws a readable Error on bad input. */
export async function caseFromFiles(files: File[], onProgress: (label: string, f: number) => void): Promise<CaseData> {
  const nifti = files.filter((f) => /\.nii(\.gz)?$/i.test(f.name));
  if (nifti.length === 0) throw new Error('Choose a .nii or .nii.gz CT (convert DICOM with dcm2niix first).');
  if (nifti.length > 2) throw new Error('Choose one CT, and optionally one label map.');
  onProgress('Reading', 0);
  const imgs = await Promise.all(nifti.map(async (f) => ({ f, img: await readNifti(await f.arrayBuffer()) })));
  let ct = imgs[0];
  let lab: (typeof imgs)[number] | null = null;
  if (imgs.length === 2) {
    const [a, b] = imgs;
    const la = looksLikeLabels(a.img);
    const lb = looksLikeLabels(b.img);
    if (la === lb) throw new Error('Could not tell which file is the CT and which is the label map.');
    ct = la ? b : a;
    lab = la ? a : b;
  } else if (looksLikeLabels(ct.img)) {
    throw new Error('That looks like a label map, not a CT. Add the CT too.');
  }
  const name = `Upload: ${ct.f.name.replace(/\.nii(\.gz)?$/i, '')}`;
  return caseFromNifti(name, ct.img, lab?.img ?? null, onProgress);
}

/** Open the browser's file picker; resolves with the chosen files (maybe none). */
export function pickFiles(): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = '.nii,.gz,.nii.gz';
    input.hidden = true;
    // Attached while open: some browsers only open a picker for an input in
    // the document.
    document.body.append(input);
    const done = (files: File[]) => {
      input.remove();
      resolve(files);
    };
    input.addEventListener('change', () => done(Array.from(input.files ?? [])));
    input.addEventListener('cancel', () => done([]));
    // One tick later: opened from inside the I key's keydown handler, Chrome
    // shows no picker (checked in a headed browser); a tick later the key's
    // user activation still holds and it opens.
    setTimeout(() => input.click(), 0);
  });
}

/** Files dropped anywhere on the page go to `onFiles`. */
export function installDrop(onFiles: (files: File[]) => void): void {
  window.addEventListener('dragover', (e) => {
    if (e.dataTransfer?.types.includes('Files')) {
      e.preventDefault();
      document.body.classList.add('dropping');
    }
  });
  window.addEventListener('dragleave', (e) => {
    if (!e.relatedTarget) document.body.classList.remove('dropping');
  });
  window.addEventListener('drop', (e) => {
    document.body.classList.remove('dropping');
    if (!e.dataTransfer?.files.length) return;
    e.preventDefault();
    onFiles(Array.from(e.dataTransfer.files));
  });
}
