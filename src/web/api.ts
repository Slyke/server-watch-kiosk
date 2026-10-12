export const unlockStorageKey = 'service-board.unlock-code';

export const readUnlockCode = (): string => {
  try {
    const code = localStorage.getItem(unlockStorageKey) ?? '';
    return /^[!-~]{1,512}$/.test(code) ? code : '';
  } catch { return ''; }
};

export const saveUnlockCode = (code: string) => {
  localStorage.setItem(unlockStorageKey, code);
};

export const forgetUnlockCode = () => {
  try { localStorage.removeItem(unlockStorageKey); } catch { /* Read-only viewing still works. */ }
};

// Only board API requests receive the code. Never put it in URLs or links.
export const apiFetch = (input: string, init: RequestInit = {}, code = readUnlockCode()): Promise<Response> => {
  const url = new URL(input, window.location.origin);
  if (url.origin !== window.location.origin || !url.pathname.startsWith('/api/v1/')) throw new Error('Expected a local board API URL');
  const headers = new Headers(init.headers);
  if (code) headers.set('Authorization', 'Bearer ' + code);
  return fetch(url, { ...init, headers, cache: 'no-store', redirect: 'error' });
};
