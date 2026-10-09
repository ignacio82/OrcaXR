/**
 * Remembered credentials over the hosts' shared contract
 * (`RememberedCredentials.ts`): the record stored text reads as, and the text
 * a record is stored as — or that nothing is stored. Every answer comes from
 * the production functions over an in-memory store; the Rust core answers the
 * same requests (`orcaxr_printer::credentials`).
 */
import type { ProjectRememberedCredentialsWire } from '../../../contracts/generated/project-intents';
import { fromUnits, units } from '../printer/PrinterWire';
import {
  loadRememberedCredentials,
  saveRememberedCredentials,
  type KeyValueStorage,
  type RememberedCredentials,
} from './RememberedCredentials';

const STORAGE_KEY = 'orcaxr.credentials';

function store(stored: string | null): KeyValueStorage & { stored: string | null } {
  const state = {
    stored,
    getItem: (key: string) => (key === STORAGE_KEY ? state.stored : null),
    setItem: (key: string, value: string) => {
      if (key === STORAGE_KEY) state.stored = value;
    },
    removeItem: (key: string) => {
      if (key === STORAGE_KEY) state.stored = null;
    },
  };
  return state;
}

export function credentialsWire(credentials: RememberedCredentials): ProjectRememberedCredentialsWire {
  return {
    printerApiKey: units(credentials.printerApiKey),
    printerApiKeys: Object.entries(credentials.printerApiKeys).map(([key, secret]) => ({
      key: units(key),
      secret: units(secret),
    })),
    slicerToken: units(credentials.slicerToken),
    remember: credentials.remember,
  };
}

/** The record stored text reads as (none: nothing stored). */
export function answerCredentialsLoad(stored: string | null): ProjectRememberedCredentialsWire {
  return credentialsWire(loadRememberedCredentials(store(stored)));
}

/** The text a record is stored as, or null when nothing is stored. */
export function answerCredentialsSave(credentials: ProjectRememberedCredentialsWire): string | null {
  // A record whose save removes the entry leaves nothing behind it.
  const target = store('previous');
  saveRememberedCredentials(
    {
      printerApiKey: fromUnits(credentials.printerApiKey),
      printerApiKeys: Object.fromEntries(
        credentials.printerApiKeys.map((entry) => [fromUnits(entry.key), fromUnits(entry.secret)]),
      ),
      slicerToken: fromUnits(credentials.slicerToken),
      remember: credentials.remember,
    },
    target,
  );
  if (target.stored === 'previous') throw new Error('The save neither stored nor removed anything');
  return target.stored;
}
