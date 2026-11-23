export const STARTER_MODEL_API_KEY: "starter_article";
export const STARTER_ENTRY_SLUG: "welcome-to-polynovea";
export const STARTER_MODEL: Readonly<{ description: string; icon: string; schema: Record<string, unknown> }>;
export const STARTER_ENTRY_DATA: Readonly<Record<string, unknown>>;

export interface StarterContentApi {
  listModels(): Promise<{ id: string; api_key?: string | null }[] | null | undefined>;
  createModel(input: { description: string; icon: string; schema: Record<string, unknown> }): Promise<{ id: string } | null | undefined>;
  listEntries(modelId: string): Promise<{ id: string; status?: string; data?: Record<string, unknown> | null }[] | null | undefined>;
  createEntry(input: { modelId: string; data: Record<string, unknown>; changeSummary: string }): Promise<{ id: string; status?: string } | null | undefined>;
}

export interface StarterContentResult {
  model: { id: string; apiKey: "starter_article"; created: boolean };
  entry: { id: string; slug: "welcome-to-polynovea"; created: boolean; status?: string };
}

export function seedStarterContent(api: StarterContentApi, options?: { changeSummary?: string }): Promise<StarterContentResult>;
