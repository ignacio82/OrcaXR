/**
 * Provider identity and lazy loader for Smart Paint.
 *
 * This module deliberately contains no provider SDK import. `@google/genai` is
 * a ~360 kB chunk; importing the adapter statically pulled it into the startup
 * graph, and the app then failed to boot with no network at all — which breaks
 * the P4.9 requirement that manual painting stays fully functional offline. The
 * adapter is therefore fetched on the first actual request, so an operator who
 * never asks an assistant never downloads one.
 */

import type { AiPaintPort, AiPaintPortRequest } from '../project/painting/AiPaintSession';

/** Stable identity the consent record is bound to; safe to name offline. */
export const GEMINI_PAINT_PROVIDER_ID = 'google-gemini';

export class LazyGeminiAiPaintPort implements AiPaintPort {
  readonly providerId = GEMINI_PAINT_PROVIDER_ID;
  private delegate?: AiPaintPort;

  async propose(request: AiPaintPortRequest): Promise<unknown> {
    if (!this.delegate) {
      const { GeminiAiPaintPort } = await import('./AiPaintService');
      this.delegate = new GeminiAiPaintPort();
    }
    return this.delegate.propose(request);
  }
}
