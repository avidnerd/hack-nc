/**
 * Makes the hosted build installable: registers the service worker and shows
 * an "Install" button in the top bar once Chrome offers the install prompt.
 * Dev builds skip all of it so the Vite server is never shadowed by a cache.
 */

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export function installPwa(): void {
  if (!import.meta.env.PROD) return;

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker
      .register(`${import.meta.env.BASE_URL}sw.js`)
      .catch((err) => console.warn('[pwa] service worker failed', err));
  }

  const btn = document.getElementById('install') as HTMLButtonElement | null;
  if (!btn) return;
  let pending: InstallPromptEvent | null = null;

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    pending = e as InstallPromptEvent;
    btn.hidden = false;
  });
  window.addEventListener('appinstalled', () => {
    pending = null;
    btn.hidden = true;
  });
  btn.addEventListener('click', async () => {
    if (!pending) return;
    await pending.prompt();
    await pending.userChoice;
    pending = null;
    btn.hidden = true;
  });
}
