/**
 * "Upload a CT": a file picker (and drag-and-drop anywhere on the page) for
 * one NIfTI CT, optionally with a label map. Which file is which is decided
 * from the voxels, not the file name: a label map holds a few small whole
 * numbers; a CT does not.
 *
 * Everything stays in the browser; nothing is uploaded to a server.
 */

import { readNifti, type NiftiImage } from './nifti.ts';
import { CONVENTIONS, caseFromNifti, guessConvention, type Convention } from './volumeCase.ts';
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

/** Distinct values of a label map (sampled, like looksLikeLabels). */
function labelValues(img: NiftiImage): number[] {
  const seen = new Set<number>();
  const step = Math.max(1, Math.floor(img.data.length / 4_000_000));
  for (let i = 0; i < img.data.length; i += step) seen.add(img.data[i]);
  return [...seen].filter((v) => v > 0).sort((a, b) => a - b);
}

/**
 * Which convention names the labels: the file names when they say (MSD
 * files are named after their task), otherwise the user is asked, because
 * "1" means liver in one dataset and spleen or a tumour in another.
 */
async function decideConvention(names: string[], values: number[], ask: () => Promise<Convention>): Promise<Convention> {
  const guess = guessConvention(names);
  if (guess) return guess;
  return values.every((v) => v === 1 || v === 2) ? ask() : 'generic';
}

/** Read the files and build the case; throws a readable Error on bad input. */
export async function caseFromFiles(
  files: File[],
  onProgress: (label: string, f: number) => void,
  ask: () => Promise<Convention> = chooseConvention,
): Promise<CaseData> {
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
  const convention = lab ? await decideConvention(nifti.map((f) => f.name), labelValues(lab.img), ask) : 'generic';
  return caseFromNifti(name, ct.img, lab?.img ?? null, onProgress, convention);
}

/** Ask what the label values mean, with the dataset conventions as choices. */
export function chooseConvention(): Promise<Convention> {
  return new Promise((resolve) => {
    const root = document.createElement('div');
    root.className = 'label-chooser';
    const card = document.createElement('div');
    card.className = 'label-chooser-card';
    const title = document.createElement('div');
    title.className = 'label-chooser-title';
    title.textContent = 'What do the labels in this file show?';
    const sub = document.createElement('div');
    sub.className = 'label-chooser-sub';
    sub.textContent = 'The same numbers mean different organs in different datasets, so pick the one this file comes from.';
    card.append(title, sub);
    const pick = (c: Convention) => {
      root.remove();
      resolve(c);
    };
    for (const [key, spec] of Object.entries(CONVENTIONS)) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = spec.title;
      b.addEventListener('click', () => pick(key as Convention));
      card.append(b);
    }
    const other = document.createElement('button');
    other.type = 'button';
    other.className = 'other';
    other.textContent = 'Something else (show them unnamed)';
    other.addEventListener('click', () => pick('generic'));
    card.append(other);
    root.append(card);
    document.body.append(root);
  });
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
