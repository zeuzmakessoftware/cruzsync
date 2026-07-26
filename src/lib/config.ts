/**
 * Server-side configuration. Read on the server only -- nothing here is ever
 * shipped to the browser except through the explicitly whitelisted
 * `publicRuntimeInfo()`, which contains no secrets.
 */

export type GemmaProvider = 'google' | 'demo';

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() !== '' ? v.trim() : undefined;
}

export interface AppConfig {
  gemmaProvider: GemmaProvider;
  gemmaModel: string;
  googleApiKey?: string;
  googlePlacesApiKey?: string;
  /** When true the app uses deterministic fixtures rather than live feeds. */
  demoMode: boolean;
  /** Whether a real Gemma call is actually possible right now. */
  gemmaLive: boolean;
}

/**
 * Model ids verified against Google's published list of Gemma models served by
 * the Gemini API. Only these two are available on generativelanguage.googleapis.com;
 * ids like `gemma-4-12b-it` exist on Hugging Face but are NOT callable there.
 */
export const SUPPORTED_GOOGLE_GEMMA_MODELS = ['gemma-4-31b-it', 'gemma-4-26b-a4b-it'] as const;

export const DEFAULT_GEMMA_MODEL = 'gemma-4-31b-it';

export function getConfig(): AppConfig {
  const provider = (env('GEMMA_PROVIDER') ?? 'google') as GemmaProvider;
  const googleApiKey = env('GOOGLE_API_KEY');
  const gemmaModel = env('GEMMA_MODEL') ?? DEFAULT_GEMMA_MODEL;
  const demoMode = (env('DEMO_MODE') ?? 'true').toLowerCase() !== 'false';
  // A live Gemma call needs both the provider selected AND a usable credential.
  const gemmaLive = provider === 'google' && Boolean(googleApiKey);
  return {
    gemmaProvider: provider,
    gemmaModel,
    googleApiKey,
    googlePlacesApiKey: env('GOOGLE_PLACES_API_KEY'),
    demoMode,
    gemmaLive,
  };
}

/** Safe to serialise to the client. Deliberately contains no key material. */
export interface PublicRuntimeInfo {
  gemmaMode: 'live-gemma' | 'deterministic-demo';
  gemmaModel: string;
  gemmaProvider: GemmaProvider;
  demoMode: boolean;
  placesProvider: 'google-places' | 'openstreetmap';
  /** Explains to a judge exactly why the badge says what it says. */
  modeReason: string;
}

export function publicRuntimeInfo(cfg = getConfig()): PublicRuntimeInfo {
  const reason = cfg.gemmaLive
    ? `Calling ${cfg.gemmaModel} on the Gemini API with native function declarations.`
    : cfg.gemmaProvider === 'demo'
      ? 'GEMMA_PROVIDER is set to "demo": explanations come from the deterministic orchestrator, not a language model.'
      : 'No GOOGLE_API_KEY is configured, so no language model is being called. All numbers still come from the deterministic engine.';
  return {
    gemmaMode: cfg.gemmaLive ? 'live-gemma' : 'deterministic-demo',
    gemmaModel: cfg.gemmaModel,
    gemmaProvider: cfg.gemmaProvider,
    demoMode: cfg.demoMode,
    placesProvider: cfg.googlePlacesApiKey ? 'google-places' : 'openstreetmap',
    modeReason: reason,
  };
}
