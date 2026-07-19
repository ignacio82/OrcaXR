export type AiProvider = 'gemini' | 'openai';

const LEGACY_STORAGE_KEYS = ['orca_gemini_key', 'orca_openai_key'] as const;
const sessionSecrets: Record<AiProvider, string> = { gemini: '', openai: '' };

/** Keep user-supplied provider credentials in this JavaScript session only. */
export function setAiSessionSecret(provider: AiProvider, value: string): void {
  sessionSecrets[provider] = value.trim();
}

export function getAiSessionSecret(provider: AiProvider): string | null {
  return sessionSecrets[provider] || null;
}

export function clearAiSessionSecrets(): void {
  sessionSecrets.gemini = '';
  sessionSecrets.openai = '';
}

/** Delete credentials written by older builds; never migrate them back into memory. */
export function purgeLegacyAiSecretStorage(
  storage: Pick<Storage, 'removeItem'> | null = typeof localStorage === 'undefined' ? null : localStorage,
): void {
  if (!storage) return;
  for (const key of LEGACY_STORAGE_KEYS) {
    try {
      storage.removeItem(key);
    } catch {
      // Restricted storage contexts are already non-persistent; keep going.
    }
  }
}

/** Remove any in-memory credential that a provider accidentally echoed. */
export function redactAiSecrets(value: string): string {
  let redacted = value;
  for (const secret of Object.values(sessionSecrets)) {
    if (secret) redacted = redacted.replaceAll(secret, '[REDACTED]');
  }
  return redacted;
}
