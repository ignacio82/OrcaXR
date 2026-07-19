import { GoogleGenAI } from '@google/genai';
import { getAiSessionSecret, redactAiSecrets } from '../security/AiSessionSecrets';

export class AiPaintService {
  static async generatePaintPlan(prompt: string, imageBase64?: string): Promise<any> {
    const apiKey = getAiSessionSecret('gemini');
    if (!apiKey) {
      throw new Error('No Gemini API Key configured.');
    }

    const ai = new GoogleGenAI({ apiKey });
    const contents: any[] = [
      {
        text: `You are an AI assistant for a 3D slicer. Given the user's paint prompt, output a JSON plan with a base_color and a list of regions. Each region should have a name, a color (as a hex code or string), and a list of 2D polygons representing the projection of that color on the 3D model. Prompt: ${prompt}`,
      },
    ];

    if (imageBase64) {
      contents.unshift({
        inlineData: {
          mimeType: 'image/jpeg',
          data: imageBase64,
        },
      });
    }

    try {
      const response = await ai.models.generateContent({
        model: 'gemini-2.5-pro',
        contents,
        config: {
          responseMimeType: 'application/json',
        },
      });
      const text = response.text;
      if (!text) throw new Error('Empty response from AI');
      return JSON.parse(text);
    } catch (error: unknown) {
      const detail = redactAiSecrets(error instanceof Error ? error.message : 'Unknown provider error');
      throw new Error(`AI paint request failed: ${detail}`, { cause: error });
    }
  }
}
