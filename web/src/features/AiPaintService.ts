/**
 * Gemini adapter for the canonical Smart Paint port (P4.9).
 *
 * It only turns a bounded request into a provider call and hands the raw
 * payload back. It does not parse, project, or apply anything: the session in
 * `project/painting/AiPaintSession` owns consent, strict parsing, the preview
 * mask, and the single undoable commit, so a provider can never reach canonical
 * state directly. Credentials stay in the JavaScript session and are redacted
 * out of every error this module raises.
 */

import { GoogleGenAI } from '@google/genai';
import type { AiPaintPort, AiPaintPortRequest } from '../project/painting/AiPaintSession';
import { getAiSessionSecret, redactAiSecrets } from '../security/AiSessionSecrets';
import { GEMINI_PAINT_PROVIDER_ID } from './aiPaintProvider';

/** Pinned so a model change is a deliberate, reviewable edit. */
const GEMINI_PAINT_MODEL = 'gemini-2.5-pro';

const PROPOSAL_INSTRUCTIONS = [
  'You plan colour regions for a 3D print. Reply with JSON only, matching exactly:',
  '{"schemaVersion":1,"regions":[{"label":string,"confidence":number,"shape":Shape}]}',
  'Shape is either {"kind":"box","min":[x,y,z],"max":[x,y,z]} with every component in [0,1]',
  "in the model's own normalized bounding box, or",
  '{"kind":"direction","axis":[x,y,z],"maxAngleDeg":number} selecting faces whose outward',
  'normal lies within maxAngleDeg of axis.',
  'confidence is your own certainty in [0,1]. Do not return polygons, colours, or filament names:',
  'the operator assigns a filament to each region afterwards. Later regions override earlier ones.',
].join(' ');

export class GeminiAiPaintPort implements AiPaintPort {
  readonly providerId = GEMINI_PAINT_PROVIDER_ID;

  async propose(request: AiPaintPortRequest): Promise<unknown> {
    const apiKey = getAiSessionSecret('gemini');
    if (!apiKey) throw new Error('No Gemini API key is configured for this session.');

    const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [];
    if (request.imageBase64) {
      parts.push({ inlineData: { mimeType: 'image/jpeg', data: request.imageBase64 } });
    }
    parts.push({
      text: [
        PROPOSAL_INSTRUCTIONS,
        request.geometry
          ? `The model has ${request.geometry.triangleCount} triangles and measures ` +
            `${request.geometry.extentMm.map((value) => value.toFixed(2)).join(' × ')} mm.`
          : 'No geometry description was shared.',
        `Request: ${request.prompt}`,
      ].join('\n'),
    });

    try {
      const response = await ai(apiKey).models.generateContent({
        model: GEMINI_PAINT_MODEL,
        contents: [{ role: 'user', parts }],
        config: { responseMimeType: 'application/json' },
        ...(request.signal ? { abortSignal: request.signal } : {}),
      });
      const text = response.text;
      if (!text) throw new Error('The assistant returned an empty response.');
      // Returned as parsed JSON, still untrusted: the session validates it.
      return JSON.parse(text) as unknown;
    } catch (error: unknown) {
      if (request.signal?.aborted) throw error;
      const detail = redactAiSecrets(error instanceof Error ? error.message : 'Unknown provider error');
      throw new Error(`Smart Paint request failed: ${detail}`, { cause: error });
    }
  }
}

function ai(apiKey: string): GoogleGenAI {
  return new GoogleGenAI({ apiKey });
}
